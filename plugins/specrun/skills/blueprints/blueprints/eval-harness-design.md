+++
id = "eval-harness-design"
title = "Eval harness design"
use_when = "Turning 'this seems better' into a number: the dataset, the scorers and the runner, before the second change to any LLM system"
pack = "evaluation"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Eval Harness Design

> The dataset, scorers, and runner that turn "does this seem better?" into a number you can compare across changes.

**Tier:** foundational
**Use when:** before the second change to any LLM system. Without it, every subsequent decision is a guess.
**Avoid when:** never. A prototype with no eval is fine; a system anyone depends on without one is not.
**Cost profile:** a day to build; minutes and cents per run. The cheapest insurance in the stack.

---

## 1. Problem it solves

LLM systems fail non-deterministically and improve non-monotonically. A prompt edit that fixes three cases silently breaks five others, and manual spot-checking finds the three. Without a fixed dataset and automated scoring, teams ship regressions continuously and only learn about them from users.

The second problem is attribution. "Quality dropped" is unactionable. A harness that reports per-category, per-component metrics tells you *what* dropped, which is the difference between a fix and a rewrite.

**The most common failure is not a bad harness — it is a dataset that does not resemble production.** Everything below depends on that dataset being real.

## 2. Shape

```
  dataset.jsonl                    system under test                scorers
  ┌──────────────┐                 ┌──────────────┐        ┌──────────────────────┐
  │ id           │                 │              │        │ deterministic        │
  │ input        │────────────────▶│  prompt /    │───────▶│  exact match, regex, │
  │ expected     │                 │  chain /     │  out   │  schema, code exec   │
  │ category     │                 │  agent /     │        ├──────────────────────┤
  │ difficulty   │                 │  RAG         │        │ LLM judge            │
  └──────────────┘                 └──────────────┘        │  rubric, temperature0│
         │                                                  └──────────┬───────────┘
         │                                                             ▼
         │                            ┌────────────────────────────────────────┐
         └───────────────────────────▶│ report: overall + per category         │
                                      │ + diff vs stored baseline              │
                                      │ + config hash                          │
                                      └────────────┬───────────────────────────┘
                                                   ▼
                                        CI gate: fail on regression
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Dataset | Fixed, versioned, representative cases | JSONL in the repo | Written by the person who wrote the prompt |
| Categories | Slice results by input type | Metadata field | Absent → aggregate hides a broken slice |
| Deterministic scorers | Exact, cheap, reproducible checks | Python asserts, schema validation, tests | Skipped in favour of an LLM judge |
| LLM judge | Score what code cannot | Strong model + rubric | Uncalibrated against humans |
| Runner | Execute, aggregate, compare | Script or a framework | Non-deterministic → noise reads as signal |
| Baseline | Stored reference metrics | JSON in the repo | Not updated deliberately |
| Config hash | Makes results comparable | Hash of prompts, model, params | Absent → comparing incomparable runs |
| Failure store | Every failing case, with output | Artifacts | Only the score is kept, so nothing is debuggable |

## 4. Data flow

1. Load the dataset; hash the system configuration (prompt text, model id, temperature, k, chunking).
2. Run every case, ideally concurrently with bounded parallelism. Record the raw output always.
3. Apply deterministic scorers first — they are free, exact, and reproducible.
4. Apply LLM judges only where code cannot decide.
5. Aggregate overall and **per category**.
6. Diff against the stored baseline for the same config hash.
7. Emit a report and a machine-readable result; fail CI on regression beyond tolerance.
8. Persist every failing case with its full output for debugging.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Any, Callable, Literal

class EvalCase(BaseModel):
    id: str
    input: dict[str, Any]
    expected: Any = Field(description="Reference output, or the criteria for a judge.")
    category: str
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    tags: list[str] = Field(default_factory=list)

class CaseResult(BaseModel):
    case_id: str
    output: Any                     # ALWAYS stored — you cannot debug a score
    scores: dict[str, float]
    passed: bool
    latency_ms: float
    tokens: dict[str, int]
    error: str | None = None

class EvalReport(BaseModel):
    config_hash: str = Field(description="Results are ONLY comparable within one hash.")
    n_cases: int
    overall: dict[str, float]
    by_category: dict[str, dict[str, float]]
    by_difficulty: dict[str, dict[str, float]]
    failures: list[CaseResult]
    cost_usd: float
    duration_s: float

Scorer = Callable[[EvalCase, Any], dict[str, float]]
```

## 6. Reference implementation

```python
import asyncio, hashlib, json, time
from pathlib import Path

def config_hash(cfg: dict) -> str:
    """Prompt text, model, temperature, k, chunking — anything that changes behaviour."""
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:12]

async def run_eval(cases: list[EvalCase], system, scorers: list[Scorer],
                   cfg: dict, concurrency: int = 8) -> EvalReport:
    sem = asyncio.Semaphore(concurrency)
    t0 = time.monotonic()

    async def one(case: EvalCase) -> CaseResult:
        async with sem:
            start = time.monotonic()
            try:
                out = await system.run(**case.input)
                scores = {}
                for scorer in scorers:
                    scores |= scorer(case, out)
                return CaseResult(case_id=case.id, output=out, scores=scores,
                                  passed=all(v >= 0.5 for v in scores.values()),
                                  latency_ms=(time.monotonic() - start) * 1000,
                                  tokens=getattr(out, "tokens", {}))
            except Exception as e:
                # An exception is a failure, not a crash. Record and continue.
                return CaseResult(case_id=case.id, output=None, scores={}, passed=False,
                                  latency_ms=(time.monotonic() - start) * 1000,
                                  tokens={}, error=f"{type(e).__name__}: {e}")

    results = await asyncio.gather(*[one(c) for c in cases])
    return aggregate(cases, results, config_hash(cfg), time.monotonic() - t0)

# ---------- deterministic scorers: free, exact, always first ----------
def exact_match(case, out) -> dict[str, float]:
    return {"exact_match": float(str(out).strip() == str(case.expected).strip())}

def schema_valid(model_cls):
    def scorer(case, out) -> dict[str, float]:
        try:
            model_cls.model_validate(out)
            return {"schema_valid": 1.0}
        except Exception:
            return {"schema_valid": 0.0}
    return scorer

def contains_all(case, out) -> dict[str, float]:
    required = case.expected.get("must_contain", [])
    if not required:
        return {}
    hit = sum(1 for s in required if s.lower() in str(out).lower())
    return {"coverage": hit / len(required)}

# ---------- regression gate ----------
def check_regression(report: EvalReport, baseline_path: Path, tolerance: float = 0.02):
    baseline = EvalReport.model_validate_json(baseline_path.read_text())
    if baseline.config_hash != report.config_hash:
        print(f"Config changed ({baseline.config_hash} → {report.config_hash}); "
              f"comparison is informational only.")
    problems = []
    for metric, value in report.overall.items():
        before = baseline.overall.get(metric)
        if before is not None and value < before - tolerance:
            problems.append(f"{metric}: {before:.3f} → {value:.3f}")
    # Per-category regressions matter even when the aggregate holds.
    for cat, metrics in report.by_category.items():
        for metric, value in metrics.items():
            before = baseline.by_category.get(cat, {}).get(metric)
            if before is not None and value < before - tolerance * 2:
                problems.append(f"[{cat}] {metric}: {before:.3f} → {value:.3f}")
    if problems:
        raise SystemExit("REGRESSION:\n  " + "\n  ".join(problems))
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Dataset size | 50 min, 150–200 good | Statistical power | ±5 pt differences need ~150 cases |
| Cases per category | ≥ 8 | Slice reliability | Below that, slice metrics are noise |
| Concurrency | 8 | Wall-clock vs rate limits | Match the provider quota |
| Regression tolerance | 2 pts overall, 4 pts per category | CI sensitivity | Tighten as variance drops |
| Judge model | strongest available | Judge ceiling | Never weaker than the system under test |
| Temperature | 0 everywhere | Reproducibility | Always, in both system and judge |
| Run frequency | deterministic on every commit; full nightly and pre-release | Cost | Deterministic scorers are free — run them constantly |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Eval scores high, users unhappy | Dataset unlike production | Compare eval and production input distributions | Source cases from real logs |
| Scores move between identical runs | Non-determinism | Same config run 3× | Temperature 0; fixed seeds; report variance |
| Aggregate flat, one slice collapsed | No per-category reporting | Per-category report | Gate on categories too |
| Cannot debug a failure | Only scores stored | Try to investigate one | Always persist the raw output |
| Baseline drifts upward silently | Baseline auto-updated on every run | Review the baseline diff | Update the baseline as a deliberate, reviewed commit |
| Comparing incomparable runs | Config changed | Config hash mismatch | Re-baseline on config change |
| Eval passes, production breaks | Only happy paths in the dataset | Failure-case coverage | Every production bug becomes a permanent case |
| Judge cost dominates | LLM judging what code could check | Cost split by scorer | Deterministic scorers first, always |

## 9. Anti-patterns

- **Building the dataset from cases the system already handles.** It measures nothing.
- **The prompt author writing the eval set.** They unconsciously write what their prompt handles.
- **Aggregate-only reporting.** One broken category stays invisible until users find it.
- **LLM judges for deterministic checks.** Slower, costlier, and less reliable than an assertion.
- **Not storing outputs.** A score with no artifact is undebuggable.
- **Auto-updating the baseline.** Regressions get absorbed silently.
- **No unanswerable / adversarial cases.** The failures that matter most are invisible.
- **Running the eval only before releases.** Regressions are found in batches, weeks after their cause.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Dataset size | Cases | ≥ 150 | < 50 |
| Category coverage | Categories with ≥ 8 cases | 100% | < 100% |
| Run reproducibility | Score variance across identical runs | < 1 pt | > 3 pts |
| Deterministic scorer share | Scores computed without an LLM | ≥ 60% | < 30% |
| Eval runtime | Wall clock, full suite | < 10 min | > 30 min |
| Cost per run | USD | < $5 | > $25 |
| Production-bug coverage | Bugs represented as cases | 100% | < 80% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Manual spot-checks |
| v1 | Second change to the system | 50 cases, deterministic scorers, a script |
| v2 | Subjective quality matters | LLM judge with a rubric, calibrated |
| v3 | Slices diverge | Categories, per-slice reporting and gates |
| v4 | Regressions ship | Baseline + CI gate + tolerance |
| v5 | Offline diverges from online | Production sampling, user feedback labels, drift monitoring |

## 12. Build checklist

- [ ] Dataset lives in the repo as JSONL and is versioned with the code.
- [ ] Cases sourced from real usage where possible; synthetic ones human-reviewed.
- [ ] Every case has a category; every category has ≥ 8 cases.
- [ ] Adversarial and should-fail cases are included.
- [ ] Deterministic scorers run first and cover everything code can decide.
- [ ] Raw outputs are stored for every case, passing or failing.
- [ ] Every report carries a config hash.
- [ ] The baseline is a reviewed commit, never auto-updated.
- [ ] CI gates on overall **and** per-category regression.
- [ ] Exceptions are recorded as failures, not crashes.
- [ ] Every production bug is added as a permanent case.

## 13. Related

- [llm-as-judge.md](llm-as-judge.md) — the scorer for what code cannot check
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — evaluating multi-step behaviour
- [regression-and-ci-evals.md](regression-and-ci-evals.md) — wiring this into CI
- [rag-evaluation.md](rag-evaluation.md) — the retrieval-specific version
