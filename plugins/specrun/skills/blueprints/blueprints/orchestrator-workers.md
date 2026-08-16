+++
id = "orchestrator-workers"
title = "Orchestrator and workers"
use_when = "A lead model has to split a task into subtasks at runtime and dispatch them to workers with their own context windows; multi-agent, search-heavy work"
pack = "agent workflows"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Orchestrator–Workers (Multi-Agent)

> A lead model decomposes a task into subtasks *at runtime*, dispatches each to a worker with its own context window and toolset, and synthesises their results.

**Tier:** advanced
**Use when:** the decomposition depends on the input and cannot be written in advance; subtasks are independent enough to run without talking to each other; the task is read/search-heavy rather than write-heavy.
**Avoid when:** subtasks must coordinate mid-flight; the task is a coherent artifact (a document, a codebase change) where workers would produce inconsistent pieces; a fixed [parallelization](parallelization.md) split works.
**Cost profile:** 5–20× a single-agent run in tokens. Justified only when the task is genuinely parallel and the answer quality gain is real.

---

## 1. Problem it solves

[Parallelization](parallelization.md) requires you to know the split at design time. "Research the competitive landscape for X" has a split that depends entirely on X — three competitors or thirty, each needing different sources.

The orchestrator lets a model make that call. The second, quieter benefit is **context isolation**: each worker burns 50k tokens exploring and returns 1k of conclusions. The orchestrator's window stays small while total work done is large.

**The hard constraint:** workers cannot see each other. Any task where piece B must be consistent with piece A is a bad fit — you get three plausible, mutually incompatible answers. Multi-agent shines on *gathering*, and fails on *composing*.

## 2. Shape

```
                            user task
                                │
                                ▼
                   ┌────────────────────────┐
                   │      ORCHESTRATOR      │  small context, sees only briefs+results
                   │  plan → dispatch →     │
                   │  assess → synthesise   │
                   └───┬────────┬────────┬──┘
        brief (self-   │        │        │
        contained,     ▼        ▼        ▼
        explicit)  ┌───────┐┌───────┐┌───────┐
                   │worker1││worker2││worker3│  own window, own tools
                   │ 50k   ││ 40k   ││ 60k   │  discarded after return
                   └───┬───┘└───┬───┘└───┬───┘
                       │ ≤2k    │ ≤2k    │ ≤2k
                       └────────┼────────┘
                                ▼
                        ┌──────────────┐
                        │  synthesis   │  may dispatch a second wave
                        └──────┬───────┘
                               ▼
                            answer
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Orchestrator | Plan, dispatch, assess coverage, synthesise | Frontier model, [agent loop](agent-loop.md) | Vague briefs → duplicated or missed work |
| Brief | Self-contained task spec for one worker | Structured object | Assumes context the worker cannot see |
| Worker | Execute one subtask in isolation | Agent loop, restricted toolset | Returns raw transcript instead of conclusions |
| Result contract | Bounded, evidence-carrying return | Pydantic model | Unbounded → orchestrator context explodes |
| Coverage check | Did the wave answer the question? | Orchestrator reasoning + rubric | Absent → premature synthesis |
| Wave budget | Cap on rounds and total workers | Counters | Absent → exponential fan-out |
| Shared artifact store | Where big outputs live | Filesystem / object store | Passing blobs through the orchestrator |

## 4. Data flow

1. Orchestrator receives the task and produces a **plan**: N briefs plus a coverage rubric.
2. Guard: if N > `max_workers_per_wave`, the orchestrator must merge briefs.
3. Briefs dispatch `‖`. Each worker gets: objective, scope boundaries, output format, tool list, effort budget. **No shared history.**
4. Each worker runs its own loop, writes large outputs to the artifact store, and returns a `WorkerResult` ≤ 2 000 tokens.
5. Orchestrator scores results against the rubric. Gaps → wave 2 with narrower briefs. Cap total waves.
6. Synthesis: orchestrator composes the final answer, reading artifacts by path only where needed.
7. Optional: a separate citation/verification pass checks every claim against evidence.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class WorkerBrief(BaseModel):
    """Must be understandable with ZERO other context. This is the whole discipline."""
    worker_id: str
    objective: str = Field(description="One sentence. What question does this worker answer?")
    scope_in: list[str] = Field(description="Explicitly in scope.")
    scope_out: list[str] = Field(description="Explicitly OUT of scope — names other workers' territory to prevent overlap.")
    output_format: str = Field(description="Exact shape expected back.")
    tools: list[str]
    effort: Literal["low", "medium", "high"] = Field(description="low≈3 tool calls, medium≈10, high≈25")
    success_criteria: str

class WorkerResult(BaseModel):
    worker_id: str
    status: Literal["complete", "partial", "failed"]
    answer: str = Field(max_length=8_000, description="Conclusions only. Never a transcript.")
    evidence: list[str] = Field(description="URLs / file:line / artifact paths. Pointers, not content.")
    artifacts: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list, description="What it could NOT determine. Drives wave 2.")
    tokens_used: int

class OrchestratorPlan(BaseModel):
    reasoning: str
    briefs: list[WorkerBrief]
    coverage_rubric: list[str] = Field(description="Questions the combined results must answer.")
```

## 6. Reference implementation

```python
import asyncio, json
from anthropic import AsyncAnthropic

client = AsyncAnthropic()

ORCHESTRATOR_SYSTEM = """You decompose a task into independent worker subtasks.

Hard rules:
1. Workers CANNOT see each other or your context. Every brief must stand alone.
2. Prevent overlap explicitly: each brief's `scope_out` names what other workers cover.
3. Scale worker count to task complexity: simple=1, comparison=2-4, broad survey=5-10. Never more.
4. Set `effort` honestly. Over-budgeting is the main source of cost blowups.
5. `coverage_rubric` is the checklist you will grade the combined results against.
Return JSON matching OrchestratorPlan."""

MAX_WAVES, MAX_WORKERS_PER_WAVE, MAX_TOTAL_WORKERS = 2, 8, 12

async def run_worker(brief: WorkerBrief, tools) -> WorkerResult:
    system = f"""You are worker {brief.worker_id}. You work alone.

OBJECTIVE: {brief.objective}
IN SCOPE: {'; '.join(brief.scope_in)}
OUT OF SCOPE (other workers handle these — do not touch): {'; '.join(brief.scope_out)}
SUCCESS: {brief.success_criteria}
EFFORT BUDGET: {brief.effort}

Return conclusions only. Cite evidence as URLs or file:line — never paste large content.
Write anything over 500 words to artifacts/ and return the path.
If you cannot determine something, list it in `gaps` rather than guessing."""

    budget = {"low": 3, "medium": 10, "high": 25}[brief.effort]
    return await agent_loop(system=system, tools=[t for t in tools if t.name in brief.tools],
                            max_steps=budget, output_model=WorkerResult)

async def orchestrate(task: str, tools) -> str:
    transcript, total_workers = [], 0

    for wave in range(MAX_WAVES):
        prompt = task if wave == 0 else (
            f"Original task: {task}\n\nWave {wave} results:\n"
            + json.dumps([r.model_dump() for r in transcript], indent=2)
            + "\n\nGrade against your rubric. Dispatch ONLY for uncovered gaps. "
              "If coverage is sufficient, return an empty `briefs` list.")

        resp = await client.messages.create(
            model="<FRONTIER_MODEL>", max_tokens=4096,
            system=ORCHESTRATOR_SYSTEM, messages=[{"role": "user", "content": prompt}])
        plan = OrchestratorPlan.model_validate_json(resp.content[0].text)

        if not plan.briefs:
            break
        briefs = plan.briefs[:min(MAX_WORKERS_PER_WAVE, MAX_TOTAL_WORKERS - total_workers)]
        total_workers += len(briefs)

        results = await asyncio.gather(*[run_worker(b, tools) for b in briefs],
                                       return_exceptions=True)
        transcript.extend(r for r in results if isinstance(r, WorkerResult))

    synth = await client.messages.create(
        model="<FRONTIER_MODEL>", max_tokens=8192,
        system="Synthesise a single coherent answer. Attribute every factual claim to "
               "evidence from the worker results. Flag contradictions between workers "
               "explicitly rather than silently picking one. Do not add facts.",
        messages=[{"role": "user", "content":
                   f"Task: {task}\n\nResults:\n"
                   + json.dumps([r.model_dump() for r in transcript], indent=2)}])
    return synth.content[0].text
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `MAX_WORKERS_PER_WAVE` | 8 | Cost ceiling per wave | Lower to 4 until quality is proven |
| `MAX_WAVES` | 2 | Depth of iteration | 3 only if wave-2 gap-filling measurably helps |
| `MAX_TOTAL_WORKERS` | 12 | Hard cost cap | Tie to a USD budget, not a count |
| Worker effort budget | model-chosen from 3 tiers | Token spend | Force `low` for cheap tasks; models over-budget by default |
| Worker model | one tier below orchestrator | Cost | Same tier only if workers do hard reasoning |
| Result cap | 2 000 tokens | Orchestrator context | Never raise without measuring occupancy |
| Worker toolset | disjoint subsets | Selection accuracy | Give each worker only what its brief needs |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Workers return near-identical findings | Briefs overlap | Pairwise similarity of results | Mandatory `scope_out` naming other workers |
| Answer has gaps nobody covered | No coverage rubric | Rubric scoring in wave 2 | Grade explicitly; dispatch a gap-filling wave |
| Cost 30× a single agent | Orchestrator spawns workers for trivial subtasks | Tokens per task, worker count histogram | Hard caps + effort tiers + "simple task = 1 worker" in the system prompt |
| Synthesis contradicts itself | Workers disagreed and synthesis papered over it | Contradiction check in synthesis | Instruct synthesis to surface conflicts; add a verification pass |
| Worker can't do its task | Brief assumed orchestrator context | `status: failed`, `gaps` populated | Validate briefs are self-contained before dispatch |
| Orchestrator context overflows | Workers return transcripts | Orchestrator token count | Enforce the result cap in code, not just in the prompt |
| Final artifact is inconsistent | Used multi-agent to *write*, not to *gather* | Human review | Workers gather; a single model composes |
| One worker fails, whole run dies | No partial-failure handling | Exception rate | `return_exceptions=True`, synthesise from what returned |

## 9. Anti-patterns

- **Multi-agent for coherent artifacts.** Three workers writing three chapters produce three voices, three sets of assumptions, and duplicate content. Gather in parallel; compose with one model.
- **Briefs that reference "the task above".** The worker cannot see it. Every brief is self-contained or it fails.
- **No scope exclusions.** Overlap is the default outcome, and you pay for it N times.
- **Unbounded waves.** Two is almost always enough; three is the ceiling.
- **Passing artifacts through the orchestrator.** Use a shared store and pass paths, or you have re-invented a single agent with extra steps.
- **Reaching for this pattern first.** Try a single agent with good [tools](tool-design.md) and [context management](context-engineering.md). Most "we need multi-agent" problems are tool-design problems.
- **Workers that can spawn workers.** Exponential cost, unattributable failures. Keep the tree two levels deep.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Quality lift vs single agent | Accuracy delta on the same eval set | ≥ +10 pts | ≤ +3 pts (drop the pattern) |
| Cost multiplier | Tokens vs single agent | ≤ 10× | > 20× |
| Worker overlap | Pairwise result similarity | < 0.3 | > 0.6 |
| Coverage | Rubric items answered | ≥ 90% | < 75% |
| Worker failure rate | `status != complete` | < 10% | > 25% |
| Orchestrator context peak | Tokens | < 40% of window | > 70% |
| Wave-2 rate | Runs needing a second wave | 20–40% | > 70% (wave-1 briefs are bad) |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Single [agent loop](agent-loop.md). Exhaust this first. |
| v1 | One agent's context can't hold the task | Fixed [parallelization](parallelization.md) with a hand-written split |
| v2 | The split depends on the input | Orchestrator plans briefs; one wave; hard caps |
| v3 | Coverage gaps in wave 1 | Rubric scoring + gap-filling wave 2 |
| v4 | Correctness is critical | Separate verification agent checking claims against evidence |

## 12. Build checklist

- [ ] A single agent was tried first and measurably fell short.
- [ ] Every brief is self-contained and passes a "would this make sense cold?" check.
- [ ] Every brief has `scope_out` naming the other workers' territory.
- [ ] Worker count, wave count, and total token spend are hard-capped in code.
- [ ] Worker results are size-capped and carry evidence pointers, not content.
- [ ] Large outputs go to a shared artifact store; only paths cross boundaries.
- [ ] A coverage rubric exists and is scored before synthesis.
- [ ] Synthesis is instructed to surface worker contradictions.
- [ ] Partial failures degrade gracefully.
- [ ] Cost per task and quality lift vs single-agent are both tracked.

## 13. Related

- [agent-loop.md](agent-loop.md) — what each worker runs internally
- [context-engineering.md](context-engineering.md) — the isolation benefit, in detail
- [parallelization.md](parallelization.md) — the fixed-split version; try it first
- [evaluator-optimizer.md](evaluator-optimizer.md) — quality via iteration instead of fan-out
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — grading multi-agent runs
