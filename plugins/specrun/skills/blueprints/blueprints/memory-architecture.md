+++
id = "memory-architecture"
title = "Memory architecture"
use_when = "The agent has to remember across sessions: facts learned in one run applying to the next, user preferences that persist, or any store of knowledge outside the context window"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Agent Memory Architecture

> The layered store of what an agent knows outside its current context window: what it learned this run, what it must remember next run, and what it knows about the user forever.

**Tier:** intermediate
**Use when:** the agent works across sessions; facts learned in one run must apply to the next; the user expects continuity ("remember I use pnpm").
**Avoid when:** every task is stateless and self-contained. Memory adds a whole class of failures — stale facts, wrong-user leakage, unbounded growth — and buys nothing if runs never repeat.
**Cost profile:** small when retrieved on demand (a grep, a few hundred tokens). Ruinous when the whole store is loaded every turn.

---

## 1. Problem it solves

The context window is RAM: fast, addressable, wiped on exit. Without a disk, every session restarts from zero — the agent re-derives the project layout, re-asks the user's preferences, and re-discovers the same dead end it hit yesterday.

The naive fix — "append everything to a memory file and prepend it to the prompt" — fails in a predictable order: the file grows past the useful size, stale facts outrank new ones, and one user's facts leak into another's session.

Memory is a retrieval problem with a write policy, not a storage problem.

## 2. Shape

```
 ┌───────────────────────── working memory (context window) ────────────────────┐
 │  system prompt · tools · recent turns · retrieved memory for THIS turn        │
 └────────▲──────────────────────────────────────────────────┬──────────────────┘
          │ retrieve (targeted)                              │ write (curated)
          │                                                  ▼
 ┌────────┴──────────┬──────────────────┬──────────────────────────────────────┐
 │  L1 SCRATCHPAD    │  L2 SESSION      │  L3 DURABLE                          │
 │  this task only   │  this session    │  across all sessions                 │
 │  artifacts/*.txt  │  NOTES.md        │  ┌──────────┬──────────┬───────────┐ │
 │  discarded on end │  survives        │  │ profile  │ semantic │ episodic  │ │
 │                   │  compaction      │  │ (prefs,  │ (facts   │ (what was │ │
 │                   │  discarded on    │  │  stack)  │  about   │  tried,   │ │
 │                   │  session end     │  │          │  domain) │  outcome) │ │
 │                   │                  │  └──────────┴──────────┴───────────┘ │
 │                   │                  │  key-value + vector index, per-tenant │
 └───────────────────┴──────────────────┴──────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| L1 scratchpad | Big intermediate outputs this task | Filesystem `artifacts/` | Contents pasted back into context |
| L2 session notes | Decisions and findings that must survive compaction | `NOTES.md`, agent-writable | Append-only → grows past usefulness |
| L3 profile | Stable user/project preferences | Key-value, one row per fact | Never expires; stale preference wins forever |
| L3 semantic | Domain facts the agent learned | Vector index + metadata | Unverified facts stored as truth |
| L3 episodic | Past attempts and their outcomes | Append log with outcome labels | Retrieval returns the failure, not the lesson |
| Write policy | Decide what is worth remembering | LLM extraction or explicit tool | Everything is remembered → noise |
| Retrieval hook | Pull only what this turn needs | grep, embedding search, key lookup | Loading the whole store |
| Tenancy guard | Hard partition by user/org | Namespace enforced in the storage layer | Cross-user leakage — the worst bug in this file |
| Curator | Merge, deduplicate, expire | Scheduled job or on-write | Absent → contradictions accumulate |

## 4. Data flow

**Read path (every turn):**
1. Derive retrieval keys from the current turn (entities, file paths, task type).
2. Always load L3 *profile* — small, always relevant.
3. Query L3 semantic/episodic with the keys; take top-k (k ≤ 5), filtered by tenant.
4. Load L2 notes for the active session.
5. Inject as a clearly delimited block with provenance and age.

**Write path (on trigger):**
1. Trigger fires: user states a preference; a task completes; pre-compaction hook; explicit `remember` tool call.
2. Extract candidate facts as structured records — never raw transcript.
3. Deduplicate against existing memory; if it contradicts an existing fact, **supersede** rather than append.
4. Attach `source`, `confidence`, `created_at`, `expires_at`, `tenant_id`.
5. Write. Enforce the per-tenant size cap; curate the oldest/lowest-confidence entries when over.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Literal

class MemoryRecord(BaseModel):
    id: str
    tenant_id: str                                     # enforced at the storage layer, not in code that can forget
    kind: Literal["profile", "semantic", "episodic"]
    key: str = Field(description="Stable slug, e.g. 'package-manager'. Enables supersede-by-key.")
    content: str = Field(max_length=500, description="One fact. Self-contained. No pronouns.")
    source: str = Field(description="'user-stated' | 'agent-inferred' | 'tool:<name>' — drives trust")
    confidence: float = Field(ge=0, le=1)
    created_at: datetime
    expires_at: datetime | None = Field(None, description="Required for anything volatile.")
    superseded_by: str | None = None
    access_count: int = 0

class MemoryQuery(BaseModel):
    tenant_id: str
    keys: list[str] = Field(default_factory=list)
    semantic_query: str | None = None
    kinds: list[str] = ["profile", "semantic", "episodic"]
    top_k: int = 5
    min_confidence: float = 0.5
```

## 6. Reference implementation

```python
from datetime import datetime, timedelta, UTC

class MemoryStore:
    def __init__(self, db, embedder, max_records_per_tenant=500):
        self.db, self.embedder, self.cap = db, embedder, max_records_per_tenant

    # ---------- write ----------
    def remember(self, rec: MemoryRecord) -> str:
        # 1. Supersede rather than accumulate: same tenant + same key = an update.
        existing = self.db.find_one(tenant_id=rec.tenant_id, key=rec.key, superseded_by=None)
        if existing:
            if existing.content.strip() == rec.content.strip():
                self.db.touch(existing.id)               # reinforce, don't duplicate
                return existing.id
            self.db.update(existing.id, superseded_by=rec.id)  # keep history, hide from reads

        # 2. User-stated facts outrank agent inferences.
        if rec.source == "agent-inferred":
            rec.confidence = min(rec.confidence, 0.7)

        # 3. Volatile kinds must expire.
        if rec.kind == "episodic" and rec.expires_at is None:
            rec.expires_at = datetime.now(UTC) + timedelta(days=90)

        self.db.insert(rec, embedding=self.embedder.embed(rec.content))
        self._enforce_cap(rec.tenant_id)
        return rec.id

    def _enforce_cap(self, tenant_id: str):
        n = self.db.count(tenant_id=tenant_id, superseded_by=None)
        if n > self.cap:
            # Evict low value: rarely accessed, low confidence, old, not a profile fact.
            self.db.evict(tenant_id=tenant_id, n=n - self.cap,
                          order_by="(access_count * confidence) ASC, created_at ASC",
                          where="kind != 'profile'")

    # ---------- read ----------
    def recall(self, q: MemoryQuery) -> list[MemoryRecord]:
        now = datetime.now(UTC)
        out: list[MemoryRecord] = []

        # Profile is small and always relevant — load it whole.
        if "profile" in q.kinds:
            out += self.db.find(tenant_id=q.tenant_id, kind="profile", superseded_by=None)

        if q.semantic_query:
            hits = self.db.vector_search(
                embedding=self.embedder.embed(q.semantic_query),
                tenant_id=q.tenant_id,                     # NEVER optional
                kinds=[k for k in q.kinds if k != "profile"],
                top_k=q.top_k)
            out += [h for h in hits if h.confidence >= q.min_confidence]

        out = [r for r in out if r.expires_at is None or r.expires_at > now]
        for r in out:
            self.db.touch(r.id)
        return out

def render_for_prompt(records: list[MemoryRecord]) -> str:
    """Provenance and age are part of the fact. Without them the model can't judge trust."""
    if not records:
        return ""
    now = datetime.now(UTC)
    lines = [f"- [{r.kind}] {r.content}  (source: {r.source}, "
             f"{(now - r.created_at).days}d old, conf {r.confidence:.1f})" for r in records]
    return ("<memory>\nFacts recalled from previous sessions. They may be stale — "
            "prefer what the user says now.\n" + "\n".join(lines) + "\n</memory>")
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `top_k` recall | 5 | Context cost vs coverage | Raise only if recall misses are measured, not suspected |
| Records per tenant | 500 | Store size, retrieval precision | Raise with better retrieval, not by default |
| Episodic TTL | 90 days | Staleness | Shorter for fast-moving projects |
| Profile TTL | none | Persistence | Profiles should be superseded, not expired |
| Write trigger | explicit + pre-compaction | Noise level | Auto-extraction on every turn creates junk |
| Inferred-fact confidence cap | 0.7 | Trust ordering | Keep below user-stated facts always |
| Memory block placement | after system, before recent turns | Cache stability | Keep it out of the cached prefix if it changes per turn |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| **Facts from another user appear** | Tenant filter missing on one query path | Audit every read for a tenant predicate; test with two tenants | Enforce tenancy in the storage layer (row-level security), not in application code |
| Agent insists on an outdated fact | No supersede, no expiry | Contradiction reports from users | Key-based supersede + TTL + "prefer what the user says now" in the render |
| Memory grows to 5 000 records | Append-only writes | Record count per tenant | Cap + eviction by `access_count × confidence` |
| Recall returns nothing useful | Facts stored with pronouns / no context | Read a sample of records | Enforce self-contained content at write time: "user prefers pnpm", not "he prefers it" |
| Every turn costs +3 000 tokens | Whole store loaded | Tokens attributable to the memory block | Targeted retrieval with `top_k`; profile-only by default |
| Cache hit rate collapses | Memory injected into the cached prefix | Cache metrics | Put memory after the stable prefix |
| Agent "remembers" a hallucination | Inferred facts stored at high confidence | Sample-audit `agent-inferred` records | Cap inferred confidence; require a tool call or user statement for ≥ 0.8 |
| Contradictory facts both retrieved | No dedup at write | Two records, same key, both active | Supersede-by-key on write |
| Episodic memory teaches the wrong lesson | Stored the failure, not the takeaway | Read episodic records | Store `attempt → outcome → lesson`, and retrieve the lesson |

## 9. Anti-patterns

- **Prepending the entire memory file to every prompt.** Costs grow with tenure, precision falls, cache breaks. Retrieve, don't resident-load.
- **Append-only memory.** Contradictions accumulate and the newest fact does not win. Supersede by key.
- **Storing raw conversation turns as "memory".** Transcripts are not facts. Extract structured records.
- **Tenant filtering in application code.** One forgotten `WHERE` and you have a data-leak incident. Push it into the storage layer.
- **Remembering everything automatically.** Signal-to-noise collapses within a week. Write on explicit triggers.
- **No provenance.** The model cannot weigh a user's explicit statement against its own guess from two months ago if both look identical.
- **Memory the user cannot see or delete.** Ship a "what do you remember about me" view and a delete path from day one — it is both a trust and a compliance requirement.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Cross-tenant leakage | Records returned outside the tenant | 0, always | ≥ 1 (incident) |
| Recall precision | Retrieved records rated relevant | ≥ 70% | < 50% |
| Memory token cost | Tokens in the memory block, p95 | < 800 | > 2 000 |
| Staleness complaints | User corrections of remembered facts | < 2% of sessions | > 5% |
| Records per tenant | p95 | < cap | at cap (eviction thrashing) |
| Supersede rate | Updates / writes | 20–40% | ~0% (append-only in disguise) |
| Continuity lift | Task success with memory vs without | ≥ +5 pts | ≤ 0 (remove memory) |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | No memory. Stateless runs. |
| v1 | Facts lost across compaction | L1 artifacts + L2 `NOTES.md` within a session |
| v2 | Users repeat preferences | L3 profile: key-value, supersede-by-key, always loaded |
| v3 | Domain knowledge accumulates | L3 semantic with embedding retrieval + TTL + confidence |
| v4 | Agent repeats past mistakes | L3 episodic: attempt → outcome → lesson, retrieved by task similarity |
| v5 | Multi-tenant production | Row-level security, user-facing memory viewer/editor, deletion API, retention policy |

## 12. Build checklist

- [ ] Tenancy is enforced in the storage layer; a two-tenant leakage test runs in CI.
- [ ] Every record is self-contained prose with no pronouns.
- [ ] Every record carries source, confidence, created_at, and a key.
- [ ] Writes supersede by key instead of appending duplicates.
- [ ] Volatile kinds have a TTL; profile facts are superseded, not expired.
- [ ] Retrieval is targeted (`top_k ≤ 5`), not a full load.
- [ ] The memory block sits outside the cached prompt prefix.
- [ ] The rendered block states age and provenance and says current input wins.
- [ ] A per-tenant record cap with an eviction policy exists.
- [ ] Users can view, edit, and delete what the agent remembers.
- [ ] Task success is measured with and without memory.

## 13. Related

- [context-engineering.md](context-engineering.md) — L1/L2 and compaction, in detail
- [agent-loop.md](agent-loop.md) — where recall is injected
- [agentic-rag.md](agentic-rag.md) — retrieval mechanics for L3 semantic
- [security-and-secrets.md](security-and-secrets.md) — tenancy and data-retention obligations
