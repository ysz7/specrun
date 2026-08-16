+++
id = "prompt-chaining"
title = "Prompt chaining"
use_when = "The steps are known in advance and always the same, and each one can be checked before the next runs — a fixed pipeline of model calls rather than an agent"
pack = "agent workflows"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Prompt Chaining

> A fixed sequence of LLM calls where each step's output is the next step's input, with deterministic code (gates) between steps.

**Tier:** foundational
**Use when:** the steps are known in advance and always the same; each step is meaningfully simpler than the whole; you can validate intermediate output programmatically.
**Avoid when:** which step comes next depends on what the previous step found — that is an [agent loop](agent-loop.md).
**Cost profile:** exactly N LLM calls, N known at design time. Latency = sum of steps. Fully predictable cost.

---

## 1. Problem it solves

A single prompt that must "extract the entities, then classify each one, then write a summary in the house style, then translate it" degrades on every sub-task at once, and when it fails you cannot tell which sub-task failed.

Chaining trades latency for accuracy: each call gets a simpler job and a narrower output contract, and you can insert a real assertion between steps. It is the most under-used pattern in agentic systems — teams reach for an autonomous agent when a three-step chain would be cheaper, faster, and testable.

**Decision rule:** if you can draw the flowchart before seeing the input, chain it. If the flowchart depends on the input, loop it.

## 2. Shape

```
 input
   │
   ▼
┌─────────┐   out₁   ┌──────┐  pass  ┌─────────┐   out₂   ┌──────┐  pass  ┌─────────┐
│ Step 1  │─────────▶│ gate │───────▶│ Step 2  │─────────▶│ gate │───────▶│ Step 3  │──▶ output
│ (LLM)   │          │ code │        │ (LLM)   │          │ code │        │ (LLM)   │
└─────────┘          └───┬──┘        └─────────┘          └───┬──┘        └─────────┘
                     fail│                                fail│
                         ▼                                    ▼
                  retry ≤ k / repair / abort           retry ≤ k / repair / abort
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Step | One narrow transformation | LLM call with structured output | Doing two jobs at once |
| Gate | Validate the step's output before it propagates | Pydantic, JSON Schema, regex, business rule | Absent → errors compound silently |
| Repair loop | Feed the validation error back for one retry | Same model + error text | Unbounded retries |
| Router (optional) | Pick which chain to run | Classifier call | See [routing.md](routing.md) |
| Trace | Record every step's I/O | OTel spans, JSONL | Missing → cannot localise failures |

## 4. Data flow

1. Input arrives, validated against the chain's input schema.
2. Step 1 runs with a step-specific system prompt and an output schema.
3. Gate 1 validates: schema + semantic assertions (non-empty, within range, IDs exist).
4. On failure: repair-retry up to `k`, then abort with the step index in the error.
5. Step 2 receives **only** what it needs — not the whole history.
6. Repeat to the terminal step; emit the final output plus the full trace.

## 5. Contracts

```python
from pydantic import BaseModel
from typing import Callable, Generic, TypeVar

I, O = TypeVar("I", bound=BaseModel), TypeVar("O", bound=BaseModel)

class Step(BaseModel, Generic[I, O]):
    name: str
    system: str
    output_model: type[O]
    gate: Callable[[O], None]     # raises GateError with an actionable message
    max_repairs: int = 1

class GateError(Exception):
    """Message is fed back to the model verbatim — write it for the model."""

class ChainTrace(BaseModel):
    step: str
    attempt: int
    input_tokens: int
    output_tokens: int
    latency_ms: float
    gate_passed: bool
    gate_error: str | None = None
```

## 6. Reference implementation

Three-step chain: outline → verify → write.

```python
from pydantic import BaseModel, Field
from anthropic import Anthropic
import json, time

client = Anthropic()

class Outline(BaseModel):
    sections: list[str] = Field(min_length=3, max_length=8)
    audience: str
    word_budget: int

class Draft(BaseModel):
    title: str
    body_markdown: str

def call_structured(system: str, user: str, model: type[BaseModel]):
    resp = client.messages.create(
        model="<MODEL_ID>", max_tokens=4096, temperature=0.2,
        system=system + f"\n\nReturn JSON matching this schema and nothing else:\n"
                        f"{json.dumps(model.model_json_schema())}",
        messages=[{"role": "user", "content": user}],
    )
    return model.model_validate_json(resp.content[0].text)

def gate_outline(o: Outline) -> None:
    if any(len(s) < 3 for s in o.sections):
        raise GateError("Section titles must be at least 3 characters. Rewrite them.")
    if o.word_budget > 3000:
        raise GateError("word_budget must be <= 3000. Reduce scope.")

def run_step(system: str, user: str, model, gate, max_repairs=1, trace=None):
    err = ""
    for attempt in range(max_repairs + 1):
        t0 = time.monotonic()
        out = call_structured(system, user + err, model)
        try:
            gate(out)
            if trace is not None:
                trace.append(ChainTrace(step=system[:30], attempt=attempt,
                                        input_tokens=0, output_tokens=0,
                                        latency_ms=(time.monotonic()-t0)*1000,
                                        gate_passed=True))
            return out
        except GateError as e:
            err = f"\n\nYour previous answer was rejected: {e}\nFix it and answer again."
    raise RuntimeError(f"Gate never passed after {max_repairs + 1} attempts")

def write_article(topic: str) -> Draft:
    trace: list[ChainTrace] = []
    outline = run_step(
        "You plan article structure. Be concrete; no filler sections.",
        f"Topic: {topic}", Outline, gate_outline, trace=trace)
    draft = run_step(
        "You write the article. Follow the outline exactly, one section per heading.",
        outline.model_dump_json(), Draft,
        gate=lambda d: (_ for _ in ()).throw(GateError("Body too short. Expand."))
                        if len(d.body_markdown) < 400 else None,
        trace=trace)
    return draft
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Step count | 2–5 | Accuracy vs latency | Above 6, ask whether a loop or [orchestrator](orchestrator-workers.md) fits better |
| `max_repairs` | 1 | Cost of a failing gate | 0 for latency-critical paths; 2 only if repairs actually succeed |
| Model per step | mixed | Cost | Cheap model for extraction/classification, strong model for generation |
| Temperature | 0.0–0.2 early, higher only for creative steps | Determinism | Keep gates strict when temperature rises |
| Parallel steps | off | Latency | Turn on where steps are genuinely independent → [parallelization](parallelization.md) |
| Context passed forward | minimal | Cost + drift | Pass the previous step's *structured output*, not the raw transcript |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Late step produces nonsense | An early step degraded and no gate caught it | Per-step gate pass rate | Add a semantic assertion, not just schema validation |
| Repairs never succeed | Gate message describes the rule, not the fix | Repair success rate | Rewrite gate messages as instructions to the model |
| Latency unacceptable | Serial steps that could be parallel | Per-step latency in trace | Parallelise independent steps |
| Cost higher than a single call | Full history re-sent every step | Input tokens per step | Pass structured output only |
| Chain works on demos, fails in prod | Input variance not represented in the design | Gate failure rate by input segment | Add a [router](routing.md) upstream for input families |
| Silent quality drift after a prompt edit | No per-step eval | Step-level accuracy in CI | Own eval set per step, not just end-to-end |

## 9. Anti-patterns

- **Chaining without gates.** Then it is just one long prompt with extra latency and extra cost. The gates are the value.
- **Passing the whole transcript forward.** Costs grow quadratically and earlier mistakes keep re-anchoring the model.
- **Gate messages written for humans.** `ValidationError: field required` teaches the model nothing. Write "The `audience` field is missing. Add it as a one-line description of the reader."
- **A "step" that does three things.** Split it; that is the entire point of the pattern.
- **Using a chain where the branch depends on the input.** Add a router or switch to a loop; do not encode the branch as an if-statement over a free-text field.
- **Unbounded repair loops.** Cap at 1–2; beyond that the model is not going to get it.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| End-to-end success | Final output passes acceptance eval | ≥ 90% | < 85% |
| Gate pass rate (first attempt) | Per step | ≥ 95% | < 85% |
| Repair success rate | Passes after repair / repairs attempted | ≥ 60% | < 30% |
| p95 latency | Wall clock | Product SLO | > SLO |
| Cost per run | USD | Fixed and known | Any variance (should be near-constant) |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | 2 steps, schema gates |
| v1 | Quality plateau | Semantic gates, repair loop, per-step evals |
| v2 | Latency pressure | Parallelise independent steps, cheaper models on easy steps |
| v3 | Input families diverge | [Routing](routing.md) to per-family chains |
| v4 | Steps become input-dependent | Convert to [agent loop](agent-loop.md) or [orchestrator-workers](orchestrator-workers.md) |

## 12. Build checklist

- [ ] Each step has one job, stateable in one sentence.
- [ ] Each step has a Pydantic/JSON-Schema output model.
- [ ] Each step has at least one *semantic* gate beyond schema validation.
- [ ] Gate error messages are written as instructions to the model.
- [ ] Repairs are capped and their success rate is measured.
- [ ] Steps receive structured output, never the raw transcript.
- [ ] Model tier is chosen per step, not globally.
- [ ] Each step has its own eval set.
- [ ] Traces record per-step tokens, latency, and gate result.

## 13. Related

- [routing.md](routing.md) — pick which chain to run
- [parallelization.md](parallelization.md) — run independent steps concurrently
- [evaluator-optimizer.md](evaluator-optimizer.md) — a chain with a feedback edge
- [agent-loop.md](agent-loop.md) — when the sequence cannot be fixed in advance
- [structured-output.md](structured-output.md) — making steps return parseable output
