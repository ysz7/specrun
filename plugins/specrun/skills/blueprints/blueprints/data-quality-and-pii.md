+++
id = "data-quality-and-pii"
title = "Data quality and PII"
use_when = "Validating what enters the index, and detecting, redacting or gating personal data before it is irreversibly embedded, logged and retrievable"
pack = "data pipelines"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Data Quality and PII

> Validating what enters the index and detecting, redacting, or gating personal and sensitive data before it becomes irreversibly embedded, logged, and retrievable.

**Tier:** intermediate
**Use when:** ingesting data that includes anything about people, or where garbage input would produce confidently wrong answers.
**Avoid when:** a fully synthetic or public corpus with no personal data and no correctness stakes. Verify that claim before believing it.
**Cost profile:** rule-based checks are free. Model-based PII detection costs per document. Both are far cheaper than a breach notification.

---

## 1. Problem it solves

Two distinct risks arrive through the same door.

**Quality:** garbage in the index produces confidently wrong answers with citations, which is worse than no answer — the citation makes it credible. Empty documents, boilerplate, near-duplicates, and wrong-language content all degrade retrieval, and none of them error.

**Privacy:** once personal data is embedded, it is in vectors, in caches, in logs, in backups, and in every model call that retrieved it. **Embeddings are not anonymisation** — the source text is stored alongside them, and vectors themselves leak information. There is no practical "delete this person from the index" unless you designed for it.

The asymmetry matters: quality problems are annoying and fixable; privacy problems are irreversible and regulated. Gate before ingestion, not after.

## 2. Shape

```
   parsed document
         │
         ▼
  ┌──────────────────────────┐
  │ QUALITY GATES            │  cheap, deterministic, first
  │  · min length            │
  │  · language detection    │──── fail ──▶ quarantine + report
  │  · boilerplate ratio     │
  │  · near-duplicate check  │
  │  · encoding sanity       │
  └───────────┬──────────────┘
              ▼
  ┌──────────────────────────┐
  │ PII DETECTION            │  rules first (cheap, high precision)
  │  regex: email, phone,    │  model second (recall on names, addresses)
  │  card, SSN, IBAN, keys   │
  │  NER: names, addresses   │──── high risk ──▶ block + alert
  └───────────┬──────────────┘
              ▼
  ┌──────────────────────────┐
  │ POLICY                   │
  │  redact · pseudonymise · │
  │  tag-and-restrict · block│
  └───────────┬──────────────┘
              ▼
  ┌──────────────────────────┐
  │ index  + subject registry│  who appears where → enables deletion requests
  └──────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Quality gates | Reject unusable documents | Deterministic rules | Absent → garbage indexed silently |
| Language detector | Route or reject by language | `fasttext`, `langdetect` | Wrong-language content silently degrades retrieval |
| Near-duplicate detector | Avoid index bloat | MinHash / SimHash | Exact match only, so near-duplicates slip through |
| Rule-based PII | High-precision structured identifiers | Regex + checksums (Luhn, IBAN) | No checksum → false positives everywhere |
| Model-based PII | Names, addresses, free-text mentions | NER, `presidio`, LLM | Run alone; misses structured identifiers |
| Redactor | Remove or replace | Deterministic pseudonymisation | Non-reversible when reversibility is needed |
| Subject registry | Who appears in which documents | Index of subject → doc ids | Absent → deletion requests are unanswerable |
| Retention enforcer | Delete on schedule | Scheduled job | Policy documented but never executed |
| Audit log | What was detected and what was done | Append-only | Logs the PII it was redacting |

## 4. Data flow

1. **Quality gates run first** — they are free, and there is no point scanning a garbage document for PII.
2. Rule-based PII detection with checksums where the format has one.
3. Model-based detection for what rules cannot catch: names, addresses, contextual identifiers.
4. Risk classification: which categories, how many, in what context.
5. Apply policy per category — redact, pseudonymise, tag-and-restrict, or block entirely.
6. If personal data is retained, record subjects in a registry mapping subject → document ids, so a deletion request is executable.
7. Index the processed content; audit what was detected and what was done — **never log the values themselves.**
8. Retention job deletes expired content from index, cache, and backups.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime

PIIType = Literal["email", "phone", "credit_card", "ssn", "iban", "passport",
                  "api_key", "person_name", "street_address", "dob", "health", "ip_address"]
Action = Literal["allow", "redact", "pseudonymise", "tag_restrict", "block"]

class QualityResult(BaseModel):
    passed: bool
    checks: dict[str, bool]
    reasons: list[str] = Field(default_factory=list)
    near_duplicate_of: str | None = None

class PIIFinding(BaseModel):
    type: PIIType
    start: int
    end: int
    confidence: float
    detector: Literal["rule", "model"]
    # NOTE: the matched VALUE is deliberately absent. Logging it defeats the purpose.

class PIIPolicy(BaseModel):
    actions: dict[PIIType, Action]
    block_threshold: int = Field(5, description="Findings of a blocking type before rejecting")
    pseudonym_salt_ref: str = Field(description="Reference to a secret. Never the salt itself.")

class SubjectRecord(BaseModel):
    subject_hash: str = Field(description="Pseudonymous handle, not the identifier.")
    document_ids: list[str]
    first_seen: datetime
    retention_until: datetime | None
```

## 6. Reference implementation

```python
import re, hashlib
from datasketch import MinHash, MinHashLSH

# ---------- quality gates: free, deterministic, first ----------
def quality_gates(doc, corpus_lsh: MinHashLSH) -> QualityResult:
    checks, reasons = {}, []
    text = doc.text_markdown

    checks["min_length"] = len(text.split()) >= 20
    if not checks["min_length"]:
        reasons.append("under 20 words")

    lang, conf = detect_language(text)
    checks["language"] = lang in {"en", "ru"} and conf > 0.7
    if not checks["language"]:
        reasons.append(f"language {lang} (conf {conf:.2f}) not supported")

    checks["encoding"] = len(re.findall(r"[�\x00-\x08]", text)) < len(text) * 0.001
    if not checks["encoding"]:
        reasons.append("encoding artefacts")

    # Near-duplicates bloat the index and dominate top-k with the same content.
    mh = MinHash(num_perm=128)
    for token in set(text.lower().split()):
        mh.update(token.encode())
    dupes = corpus_lsh.query(mh)
    checks["not_duplicate"] = not dupes
    if dupes:
        reasons.append(f"near-duplicate of {dupes[0]}")

    return QualityResult(passed=all(checks.values()), checks=checks, reasons=reasons,
                         near_duplicate_of=dupes[0] if dupes else None)

# ---------- PII: rules first (precision), then model (recall) ----------
def luhn_valid(number: str) -> bool:
    digits = [int(d) for d in re.sub(r"\D", "", number)][::-1]
    total = sum(d if i % 2 == 0 else sum(divmod(d * 2, 10))
                for i, d in enumerate(digits))
    return len(digits) >= 13 and total % 10 == 0

RULES = {
    "email": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"),
    "credit_card": re.compile(r"\b(?:\d[ -]?){13,19}\b"),
    "iban": re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b"),
    "api_key": re.compile(r"\b(?:sk|pk|ghp|xoxb)[-_][A-Za-z0-9_-]{20,}\b"),
}

def detect_pii_rules(text: str) -> list[PIIFinding]:
    out = []
    for pii_type, pattern in RULES.items():
        for m in pattern.finditer(text):
            # Checksums turn a noisy regex into a precise detector.
            if pii_type == "credit_card" and not luhn_valid(m.group()):
                continue
            out.append(PIIFinding(type=pii_type, start=m.start(), end=m.end(),
                                  confidence=0.95, detector="rule"))
    return out

def apply_policy(text: str, findings: list[PIIFinding], policy: PIIPolicy,
                 salt: bytes) -> tuple[str, Action]:
    blocking = sum(1 for f in findings if policy.actions.get(f.type) == "block")
    if blocking >= policy.block_threshold:
        return "", "block"

    # Replace right-to-left so earlier offsets stay valid.
    out = text
    for f in sorted(findings, key=lambda f: -f.start):
        action = policy.actions.get(f.type, "redact")
        original = text[f.start:f.end]
        if action == "redact":
            out = out[:f.start] + f"[{f.type.upper()}_REDACTED]" + out[f.end:]
        elif action == "pseudonymise":
            # Deterministic: the same value maps to the same token, so relationships
            # in the data survive while the identifier does not.
            token = hashlib.blake2b(original.encode(), key=salt, digest_size=8).hexdigest()
            out = out[:f.start] + f"[{f.type}:{token}]" + out[f.end:]
    return out, "redact"
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Min document length | 20 words | Noise rejection | Lower for FAQ or short-record corpora |
| Near-duplicate threshold | Jaccard 0.9 | Index bloat | Lower to catch templated documents |
| Language allowlist | corpus languages | Retrieval quality | Add per-language indexes rather than mixing |
| Rule vs model PII | rules first, model second | Cost vs recall | Model-based for free-text-heavy corpora |
| Block threshold | 5 findings | Ingestion strictness | 1 for regulated data |
| Pseudonymisation | deterministic, salted | Analysis vs privacy | Non-deterministic when linkage must be impossible |
| Retention | source-defined | Compliance | Enforce, do not just document |
| Subject registry | on if personal data is retained | Deletion feasibility | Required wherever deletion rights apply |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Wrong answers with citations | Garbage indexed | Read random chunks | Quality gates before indexing |
| Top-k dominated by one document | Near-duplicates | Result diversity | MinHash deduplication at ingest |
| PII in the vector store | Detection after embedding | Scan a sample of indexed text | Detect **before** embedding |
| PII in logs | Findings logged with values | Log audit | Log types and offsets, never values |
| Cannot honour a deletion request | No subject registry | Attempt one | Registry mapping subject → documents |
| Credit-card regex false positives | No checksum | Redaction rate spike | Luhn validation |
| Names missed entirely | Rules only | Manual review sample | Add model-based NER |
| Data past retention still searchable | Policy documented, not executed | Age distribution in the index | Scheduled deletion job across index, cache, backups |
| Redaction breaks meaning | Over-redaction | Retrieval quality drop | Pseudonymise instead of redact where relationships matter |

## 9. Anti-patterns

- **PII scanning after embedding.** The vector, the stored text, the cache, and the logs already contain it. Scan first.
- **Treating embeddings as anonymisation.** They are not, and the source text is stored beside them anyway.
- **Logging detected PII values.** The detection log becomes the leak.
- **Regex without checksums.** Every 13-digit number becomes a "credit card".
- **Model-based detection alone.** NER misses structured identifiers that regex catches perfectly.
- **No subject registry.** Deletion requests become unanswerable, and that is a compliance failure, not an inconvenience.
- **A retention policy nobody executes.** Documented and unenforced is worse than absent — it is a false claim.
- **Deleting from the index but not from caches and backups.** The data is still there.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Quality gate pass rate | Documents passing | > 95% | < 85% |
| Near-duplicate rate | Documents rejected as duplicates | < 5% | > 20% |
| PII detection recall | On a labelled test set | ≥ 95% | < 85% |
| PII detection precision | On a labelled test set | ≥ 90% | < 75% |
| PII in the index | Findings on a sampled scan | 0 | ≥ 1 (incident) |
| Deletion request SLA | Request → fully removed | < 30 days | > SLA |
| Retention compliance | Content past retention | 0 | ≥ 1 |
| Quarantine rate | Documents held for review | < 5% | > 15% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | No validation |
| v1 | Garbage in results | Quality gates: length, language, encoding |
| v2 | Duplicates dominate top-k | MinHash near-duplicate detection |
| v3 | Personal data enters the corpus | Rule-based PII detection + redaction before embedding |
| v4 | Free-text personal data | Model-based NER alongside rules |
| v5 | Regulated data | Subject registry, enforced retention, deletion API, audited access |

## 12. Build checklist

- [ ] Quality gates run before any expensive processing.
- [ ] Language is detected; unsupported languages are routed or rejected.
- [ ] Near-duplicate detection uses MinHash/SimHash, not exact matching.
- [ ] PII detection runs **before** embedding, not after.
- [ ] Rule-based detectors use checksums where the format has one.
- [ ] Model-based detection covers names and addresses.
- [ ] Audit logs record type and offset, never the matched value.
- [ ] Pseudonymisation is deterministic and salted with a referenced secret.
- [ ] A subject registry maps subjects to document ids.
- [ ] Deletion removes from index, cache, logs, and backups.
- [ ] Retention is enforced by a scheduled job, not just documented.
- [ ] PII detection recall and precision are measured on a labelled set.

## 13. Related

- [ingestion-pipeline.md](ingestion-pipeline.md) — where these gates sit
- [document-parsing.md](document-parsing.md) — the stage before this
- [embedding-pipeline.md](embedding-pipeline.md) — the point of no return for PII
- [security-and-secrets.md](security-and-secrets.md) — access control and retention
- [memory-architecture.md](memory-architecture.md) — the same obligations for agent memory
