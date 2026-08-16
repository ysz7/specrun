+++
id = "parallelization"
title = "Parallelization"
use_when = "Running model calls concurrently — independent sections merged at the end, or the same task sampled several times and voted on to raise reliability"
pack = "agent workflows"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Parallelization (Sectioning and Voting)

> Running multiple LLM calls concurrently and aggregating their outputs — either because the work splits into independent sections, or because repeating the same work and combining answers raises reliability.

**Tier:** foundational
**Use when:** subtasks are genuinely independent (sectioning), or a single sample is unreliable and you can afford N× cost (voting).
**Avoid when:** later work depends on earlier results — that is [prompt chaining](prompt-chaining.md). Or when a single call is already reliable enough; voting on an easy task is pure waste.
**Cost profile:** N× tokens, ~1× latency. Voting's cost is linear; its accuracy gain is sub-linear and saturates around N=5.

---

## 1. Problem it solves

Two different problems share one mechanism.

**Sectioning** — a task decomposes into parts that do not need each other: review a PR for security, performance, and style; summarise 40 documents; extract 12 independent fields. Running them serially wastes wall-clock time, and putting them in one prompt makes each part worse because attention is split.

**Voting** — a single sample on a hard judgement is noisy. Sampling k times and aggregating trades money for variance reduction. It also lets you set an explicit sensitivity: "flag if *any* of 3 reviewers finds a vulnerability" is a different, deliberately paranoid, operating point than "flag if the majority does".

## 2. Shape

```
SECTIONING                              VOTING
                                        
   input                                   input
     │                                       │
 ┌───┴───┬───────┐                    ┌──────┼──────┐
 ▼       ▼       ▼                    ▼      ▼      ▼
sec A  sec B  sec C                 run₁   run₂   run₃    (same task,
(diff  (diff  (diff                (diff prompt or         diff seed/
prompt)prompt)prompt)               diff temperature)      prompt variant)
 │       │       │                    │      │      │
 └───┬───┴───────┘                    └──────┼──────┘
     ▼                                       ▼
 ┌─────────┐                          ┌─────────────┐
 │ merge   │  deterministic or LLM    │ aggregate   │  majority / any / mean
 └─────────┘                          └─────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Splitter | Cut input into independent units | Code, rarely an LLM | Splitting things that are actually dependent |
| Workers | Identical or per-section prompts | `asyncio.gather`, thread pool | Unbounded fan-out → rate limits |
| Aggregator | Combine into one answer | Code (preferred) or an LLM call | LLM aggregator introduces its own errors |
| Concurrency limiter | Bound in-flight requests | Semaphore | Absent → 429 storm |
| Partial-failure policy | Decide behaviour when 1 of N fails | Code | Whole run fails on one flaky call |

## 4. Data flow

**Sectioning:** split → `‖` run all sections → collect (with per-section failure handling) → merge deterministically → return.

**Voting:** duplicate input k ways with varied prompt/temperature → `‖` run → parse each to a comparable type → aggregate by policy → return with agreement score.

Both: always attach *which* worker produced *what*, so failures are localisable.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal, TypeVar, Generic

T = TypeVar("T")

class WorkerOutcome(BaseModel, Generic[T]):
    worker_id: str
    ok: bool
    value: T | None = None
    error: str | None = None
    latency_ms: float

class VoteResult(BaseModel, Generic[T]):
    decision: T
    policy: Literal["majority", "any", "all", "mean"]
    agreement: float = Field(ge=0, le=1, description="Fraction of voters supporting `decision`")
    votes: list[T]
    dissent: list[str] = Field(description="Reasons from voters who disagreed. Keep these.")
```

## 6. Reference implementation

```python
import asyncio, collections
from anthropic import AsyncAnthropic

client = AsyncAnthropic()
SEM = asyncio.Semaphore(8)          # bound concurrency or you will get rate limited

async def call(system: str, user: str, temperature: float = 0.0) -> str:
    async with SEM:
        resp = await client.messages.create(
            model="<MODEL_ID>", max_tokens=2048, temperature=temperature,
            system=system, messages=[{"role": "user", "content": user}])
        return resp.content[0].text

# ---------- Sectioning ----------
REVIEWERS = {
    "security":    "You review ONLY for security defects: injection, authz, secrets, unsafe deserialisation. Ignore style and performance.",
    "performance": "You review ONLY for performance: N+1 queries, unbounded allocations, blocking I/O in async paths. Ignore style and security.",
    "style":       "You review ONLY for readability and project conventions. Ignore security and performance.",
}

async def review_pr(diff: str) -> dict[str, str]:
    tasks = {k: call(v, diff) for k, v in REVIEWERS.items()}
    done = await asyncio.gather(*tasks.values(), return_exceptions=True)
    out = {}
    for (name, _), result in zip(tasks.items(), done):
        out[name] = f"[FAILED: {result}]" if isinstance(result, Exception) else result
    return out                       # merged deterministically by the caller

# ---------- Voting ----------
async def vote_is_vulnerable(code: str, k: int = 3) -> VoteResult[bool]:
    variants = [
        "You are a security auditor. Answer YES or NO only: does this code contain a vulnerability?",
        "You are an attacker. Answer YES or NO only: can this code be exploited?",
        "You are a code reviewer. Answer YES or NO only: would you block this for a security concern?",
    ][:k]
    raw = await asyncio.gather(*[call(v, code, temperature=0.3) for v in variants])
    votes = [r.strip().upper().startswith("Y") for r in raw]

    # `any` policy: deliberately paranoid — one reviewer flagging is enough.
    decision = any(votes)
    agreement = sum(v == decision for v in votes) / len(votes)
    return VoteResult(decision=decision, policy="any", agreement=agreement,
                      votes=votes, dissent=[r for r, v in zip(raw, votes) if v != decision])
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Concurrency limit | 8 | Rate limits vs wall clock | Match your provider's RPM/TPM quota |
| `k` (voters) | 3 | Accuracy vs cost | 5 for high-stakes; > 5 rarely pays |
| Voting policy | majority | Sensitivity | `any` when false negatives are costly; `all` when false positives are |
| Voter diversity | prompt variants | Correlated errors | Vary the *framing*, not just the seed — same prompt sampled thrice is weakly diverse |
| Temperature (voting) | 0.3–0.7 | Sample diversity | 0 makes voting nearly pointless |
| Partial-failure policy | degrade | Robustness | Fail hard only when every section is mandatory |
| Aggregator | code | Reliability | Use an LLM aggregator only for free-text merges |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| 429 / rate limit storms | Unbounded fan-out | Error rate on burst | Semaphore + exponential backoff + jitter |
| Voting doesn't help | Voters make the same mistake (correlated errors) | Agreement ~1.0 but accuracy flat | Diversify by prompt framing, model, or evidence given |
| Merged output contradicts itself | Sections weren't independent | Human review of merges | Re-split, or add a reconciliation step |
| One slow worker dominates latency | No per-worker timeout | p95 vs p50 gap | Per-worker timeout + degrade on miss |
| Cost 5× with no quality gain | Voting on an easy task | Accuracy at k=1 vs k=5 | Measure before adopting; drop to k=1 |
| Duplicated content in the merge | Overlapping sections | Manual read | Make the splitter produce disjoint units and say so in each prompt |
| Aggregator loses the dissent | Only the winning vote is kept | Post-hoc audits impossible | Always persist dissenting reasons |

## 9. Anti-patterns

- **Voting with identical prompts at temperature 0.** Three identical answers. Diversity must be engineered.
- **Sectioning dependent work.** If section B needs A's output, this is a chain, and parallelising it silently degrades B.
- **Unbounded `asyncio.gather` over 500 items.** Chunk it and bound concurrency.
- **LLM aggregation where code would do.** Summing scores, taking a max, or unioning lists is deterministic — don't spend a call and an error source on it.
- **Discarding minority opinions.** On high-stakes calls the dissent is the most valuable output.
- **Measuring accuracy only in aggregate.** Track per-section and per-voter accuracy; usually one section is dragging the whole thing down.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Speedup | serial latency / parallel latency | ≥ 0.7 × N | < 0.4 × N |
| Voting lift | accuracy at k vs k=1 | ≥ +5 pts | ≤ +1 pt (drop voting) |
| Inter-voter agreement | mean pairwise | 0.6–0.9 | > 0.95 (no diversity) or < 0.4 (task ill-posed) |
| Partial failure rate | runs with ≥ 1 failed worker | < 2% | > 10% |
| Cost multiplier | vs single call | = k, known | unexpected drift |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Serial loop |
| v1 | Latency complaints | `asyncio.gather` + semaphore |
| v2 | Rate limits | Backoff, jitter, per-worker timeouts, degrade-on-failure |
| v3 | Reliability requirement | Voting with engineered prompt diversity |
| v4 | Sections become input-dependent | [Orchestrator-workers](orchestrator-workers.md): let a model decide the split |

## 12. Build checklist

- [ ] Sections are provably independent; each prompt says to ignore the others' concerns.
- [ ] Concurrency is bounded by a semaphore sized to the provider quota.
- [ ] Every worker has a timeout and a named id in its result.
- [ ] Partial failures degrade rather than abort, unless the section is mandatory.
- [ ] The aggregator is deterministic code wherever possible.
- [ ] Voting diversity comes from prompt framing, not seed alone.
- [ ] Voting lift over k=1 is measured before shipping.
- [ ] Dissenting opinions are persisted, not discarded.
- [ ] Backoff with jitter on 429/5xx.

## 13. Related

- [prompt-chaining.md](prompt-chaining.md) — the serial counterpart
- [orchestrator-workers.md](orchestrator-workers.md) — dynamic, model-decided splits
- [evaluator-optimizer.md](evaluator-optimizer.md) — quality via iteration instead of quantity
- [cost-and-rate-limits.md](cost-and-rate-limits.md) — sizing the semaphore
