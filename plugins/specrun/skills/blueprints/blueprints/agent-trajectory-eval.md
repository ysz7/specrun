+++
id = "agent-trajectory-eval"
title = "Agent trajectory evaluation"
use_when = "Grading the path a multi-step agent took — which tools it chose, in what order, how it recovered from errors and what it cost — not only its final answer"
pack = "evaluation"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Agent Trajectory Evaluation

> Grading not just the agent's final answer but the path it took — which tools it chose, in what order, how it recovered from errors, and what it cost.

**Tier:** advanced
**Use when:** evaluating any multi-step agent. A correct answer reached by a lucky path is a system you cannot improve or trust.
**Avoid when:** the system is single-turn. Then the output *is* the trajectory.
**Cost profile:** running the agent per case is the dominant cost — often 10–50× a single-turn eval. Budget accordingly and keep the deterministic checks free.

---

## 1. Problem it solves

Final-answer accuracy tells you almost nothing about an agent. Two runs both answering correctly can be:

- 3 tool calls, no errors, $0.02 — a healthy system
- 18 tool calls, 6 errors, two repeated searches, $0.40 — a system about to fail on a slightly harder case

And a *wrong* answer's cause is invisible in the answer: wrong tool, bad arguments, unreadable tool output, or a genuine reasoning error all look identical from the outside.

Trajectory evaluation makes the mechanism visible. It also catches the failure that end-to-end scores systematically miss: **an agent that gets the right answer for the wrong reason**, which will not generalise.

## 2. Shape

```
  case: task + expected outcome + expected tool set + budget
        │
        ▼
  ┌─────────────────── run agent, record everything ────────────────────┐
  │ step │ tool          │ args        │ result   │ tokens │ latency    │
  │  0   │ search_docs   │ {q:"..."}   │ 5 hits   │  1204  │  340ms     │
  │  1   │ get_logs      │ {id:"..."}  │ ERROR    │   180  │   90ms     │
  │  2   │ list_services │ {}          │ 12 rows  │   420  │  110ms     │
  │  3   │ get_logs      │ {id:"..."}  │ 200 rows │  2100  │  520ms     │
  │  4   │ (none)        │             │ answer   │   890  │  1.1s      │
  └──────────────────────────┬──────────────────────────────────────────┘
                             ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ DETERMINISTIC (free)          │ JUDGE (costly)                        │
  │ · outcome correct?            │ · was each tool choice justified      │
  │ · required tools called?      │   given what it knew at that step?    │
  │ · forbidden tools avoided?    │ · did it recover sensibly from the    │
  │ · steps / tokens / cost       │   error at step 1?                    │
  │ · repeated identical calls    │ · was any step unnecessary?           │
  │ · error → recovery happened   │                                       │
  └──────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Trace recorder | Capture every step completely | Structured JSONL per run | Missing args or results → nothing is debuggable |
| Outcome scorer | Did it achieve the goal? | Deterministic where possible | The only metric anyone tracks |
| Tool-choice scorer | Right tools, right order | Required / forbidden sets | Over-specified: exact sequence matching |
| Efficiency scorer | Steps, tokens, cost, latency | Pure arithmetic | Ignored until the bill arrives |
| Recovery scorer | Behaviour after an error | Did the next step change approach? | Errors counted but recovery unmeasured |
| Loop detector | Repeated `(tool, args)` | Hash-based | Absent → loops look like "slow" |
| Trajectory judge | Step-level justification | LLM with the step's visible state | Judged with hindsight the agent lacked |
| Cost accounting | Per-run tokens and USD | From usage fields | Not attributed per case |

## 4. Data flow

1. Each case declares: the task, the expected outcome, `required_tools`, `forbidden_tools`, and a step/cost budget.
2. Run the agent, recording every step: tool, arguments, result, error flag, tokens, latency.
3. Deterministic scorers run first — outcome, tool sets, efficiency, loop detection, recovery presence. Free and exact.
4. The trajectory judge scores step justification, given **only what the agent could see at that step**. Hindsight invalidates the judgement.
5. Aggregate per category and per difficulty; compare against the baseline.
6. Persist full traces for every failure.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Any, Literal

class Step(BaseModel):
    index: int
    tool: str | None                    # None on the final answer turn
    args: dict[str, Any] = {}
    result: str = ""
    is_error: bool = False
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: float = 0

class Trajectory(BaseModel):
    case_id: str
    steps: list[Step]
    final_answer: str
    terminated: Literal["answered", "step_cap", "time_cap", "error"]
    total_tokens: int
    cost_usd: float
    duration_s: float

class TrajectoryCase(BaseModel):
    id: str
    task: str
    expected_outcome: str
    required_tools: set[str] = Field(default_factory=set,
                                     description="Must be called at least once.")
    forbidden_tools: set[str] = Field(default_factory=set,
                                      description="Calling any of these is a failure.")
    max_steps: int = 10
    max_cost_usd: float = 0.10
    # Deliberately NOT an exact tool sequence — many correct paths exist.

class TrajectoryScores(BaseModel):
    outcome_correct: float
    required_tools_used: float
    forbidden_tools_avoided: float
    step_efficiency: float              # 1.0 if within budget, degrading past it
    no_redundant_calls: float
    error_recovery: float
    step_justification: float           # judge
    within_cost_budget: float
```

## 6. Reference implementation

```python
import hashlib, json

def deterministic_scores(traj: Trajectory, case: TrajectoryCase) -> dict[str, float]:
    used = {s.tool for s in traj.steps if s.tool}

    required = (len(case.required_tools & used) / len(case.required_tools)
                if case.required_tools else 1.0)
    forbidden = 0.0 if (case.forbidden_tools & used) else 1.0

    n = len([s for s in traj.steps if s.tool])
    efficiency = 1.0 if n <= case.max_steps else max(0.0, 1 - (n - case.max_steps) / case.max_steps)

    # Redundancy: identical (tool, args) more than once is almost always a defect.
    sigs = [hashlib.sha256(f"{s.tool}{json.dumps(s.args, sort_keys=True)}".encode()).hexdigest()
            for s in traj.steps if s.tool]
    no_redundant = 1.0 if len(sigs) == len(set(sigs)) else len(set(sigs)) / max(len(sigs), 1)

    # Recovery: after an error, did the very next call CHANGE approach?
    recoveries, opportunities = 0, 0
    for i, s in enumerate(traj.steps[:-1]):
        if s.is_error:
            opportunities += 1
            nxt = traj.steps[i + 1]
            if nxt.tool != s.tool or nxt.args != s.args:
                recoveries += 1
    recovery = recoveries / opportunities if opportunities else 1.0

    return {
        "required_tools_used": required,
        "forbidden_tools_avoided": forbidden,
        "step_efficiency": efficiency,
        "no_redundant_calls": no_redundant,
        "error_recovery": recovery,
        "within_cost_budget": float(traj.cost_usd <= case.max_cost_usd),
    }

TRAJECTORY_JUDGE = """Evaluate each step of an agent trajectory.

CRITICAL: judge each step using ONLY what the agent could see at that point — the task and
the results of PRIOR steps. Do not use hindsight. A reasonable step that turned out to be a
dead end is still a reasonable step.

For each step return:
- justified: true/false — was this a sensible action given what was known?
- necessary: true/false — did this step contribute to the answer, or was it redundant?
- reasoning: one sentence

Then: first_divergence — the index of the first step that was NOT justified, or null.
Return JSON."""

async def judge_trajectory(traj: Trajectory, case: TrajectoryCase) -> dict:
    rendered = "\n".join(
        f"[{s.index}] {s.tool}({json.dumps(s.args)}) → "
        f"{'ERROR: ' if s.is_error else ''}{s.result[:300]}"
        for s in traj.steps if s.tool)
    r = await client.messages.create(
        model="<STRONGEST_MODEL>", max_tokens=2500, temperature=0, system=TRAJECTORY_JUDGE,
        messages=[{"role": "user", "content":
                   f"TASK:\n{case.task}\n\nTRAJECTORY:\n{rendered}\n\n"
                   f"FINAL ANSWER:\n{traj.final_answer}"}])
    return json.loads(r.content[0].text)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Tool matching | required/forbidden sets | Flexibility | Never exact sequences — many valid paths exist |
| Step budget per case | task-specific | Efficiency scoring | Set from the p50 of healthy runs, not the cap |
| Cost budget per case | task-specific | Cost regression detection | Always set one |
| Judge scope | step-level justification | Cost vs insight | Sample-judge if cost is prohibitive |
| Hindsight prevention | prior steps only | Judge validity | Never show the judge the final outcome first |
| Redundancy threshold | any exact repeat | Loop detection | Keep strict |
| Trace retention | all failures, sampled passes | Debuggability | Always keep failures |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| High accuracy, rising cost | Agent takes longer paths for the same answers | Steps and cost per case over time | Efficiency and cost in the gate, not just outcome |
| Judge penalises reasonable exploration | Hindsight bias | Judge marks dead ends unjustified | Show only prior steps; state the rule explicitly |
| Eval passes, production fails | Cases are easier than reality | Compare eval and production step distributions | Source cases from production traces |
| Cannot tell why a case failed | Traces not stored | Try to debug one | Persist full traces for every failure |
| Exact-sequence matching fails good runs | Over-specified expectations | Failures with correct outcomes | Required/forbidden sets, not sequences |
| Loops counted as "slow" | No redundancy detection | Identical call hashes | Explicit redundancy scorer |
| Errors ignored in scoring | Only the outcome measured | Error rate vs outcome score | Recovery scorer |
| Eval cost is prohibitive | Running the full agent on 200 cases | Cost per eval run | Tiered: 30 cases per commit, full nightly |

## 9. Anti-patterns

- **Scoring only the final answer.** The right answer by luck is a system you cannot improve.
- **Expecting an exact tool sequence.** Most tasks have several correct paths; you will fail good runs.
- **Judging with hindsight.** Every exploratory step looks wasteful once you know the answer.
- **No cost budget per case.** Cost regressions are invisible until the invoice.
- **Discarding traces on success.** The healthy-run distribution is what you compare against.
- **Ignoring error recovery.** An agent that errors and adapts is healthier than one that never errors because it never tries.
- **Running the full suite on every commit.** Too slow and too expensive; tier it.
- **No production-sourced cases.** Synthetic tasks are systematically easier.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Outcome accuracy | Cases achieving the expected outcome | ≥ 85% | < 75% |
| Step efficiency | Steps vs budget, p50 | ≤ 1.0 | > 1.5 |
| Cost per case | USD, p50 / p95 | within budget | p95 > 2× budget |
| Redundant call rate | Runs with an exact repeat | < 5% | > 15% |
| Error recovery rate | Errors followed by a changed approach | ≥ 80% | < 50% |
| Step justification | Judge score, mean | ≥ 0.9 | < 0.75 |
| Forbidden tool usage | Any occurrence | 0 | ≥ 1 |
| Termination by cap | Runs hitting step or time caps | < 5% | > 15% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Manual trace reading |
| v1 | Agent behaviour changes unpredictably | Structured trace recording on every run |
| v2 | Second change to the agent | Deterministic scorers: outcome, tools, steps, cost |
| v3 | Loops and non-recovery appear | Redundancy and recovery scorers |
| v4 | "Right answer, wrong path" cases | Trajectory judge with hindsight prevention |
| v5 | Continuous operation | Production trace sampling into the eval set; cost and efficiency gating in CI |

## 12. Build checklist

- [ ] Every run emits a complete structured trace: tool, args, result, error, tokens, latency.
- [ ] Cases declare required tools, forbidden tools, and step/cost budgets — not exact sequences.
- [ ] Deterministic scorers cover outcome, tool sets, efficiency, redundancy, and recovery.
- [ ] The trajectory judge sees only prior steps, never the outcome first.
- [ ] Redundant identical calls are detected and scored.
- [ ] Error recovery is measured as a changed approach after an error.
- [ ] Cost per case is budgeted and gated.
- [ ] Full traces are persisted for every failure.
- [ ] Cases are sourced from real production traces where possible.
- [ ] The suite is tiered: a fast subset per commit, the full run nightly.

## 13. Related

- [eval-harness-design.md](eval-harness-design.md) — the surrounding harness
- [llm-as-judge.md](llm-as-judge.md) — calibrating the trajectory judge
- [agent-loop.md](agent-loop.md) — what is being measured
