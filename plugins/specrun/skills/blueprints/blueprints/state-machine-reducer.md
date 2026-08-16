+++
id = "state-machine-reducer"
title = "State machine and reducer"
use_when = "State changes have to be deterministic and auditable while the model only decides; the agent loses the thread because its state lives in the conversation"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# State Machine and Reducer

> Separating what the model *decides* (probabilistic) from how state *changes* (deterministic) —
> the model proposes an action, code commits the transition.

**Tier:** foundational
**Use when:** the agent's work has states someone would recognise, or any state change has
consequences worth auditing.
**Avoid when:** single-turn Q&A with no state at all.
**Cost profile:** free. Consistently reported as the largest single reliability gain available
in agent architecture.

---

## 1. Problem it solves

In a naive agent, state lives in the conversation. "The order is now shipped" is a sentence in
the transcript. That means:

- State can be **contradicted** by a later sentence, and nothing notices.
- State can be **invented** — the model says a step completed when it did not.
- State cannot be **queried** — you cannot ask "how many cases are awaiting review".
- State cannot **survive** a compaction, a crash, or a deploy.
- An **injected instruction** can rewrite it, because it is just text.

The fix is structural: state is a typed object in a store, and transitions are functions in your
code. The model's output is an *intent*; the reducer decides whether that intent is a legal
transition and what the new state is.

**The model proposes. The reducer disposes.** Everything below is that sentence, implemented.

## 2. Shape

```
 ┌────────────────────────────────────────────────────────────────┐
 │ STATE (typed, persisted, queryable)                             │
 │   status · collected facts · decisions · artifacts · history    │
 └────────────────────────┬───────────────────────────────────────┘
                          │ rendered into the prompt (a VIEW, not the state itself)
                          ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ MODEL          ── probabilistic ──                              │
 │   given the state, propose ONE action                           │
 └────────────────────────┬───────────────────────────────────────┘
                          │ Action (typed, validated)
                          ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ REDUCER        ── deterministic, your code ──                   │
 │   1. is this action legal in this state?   no → reject, tell    │
 │      (transition table, not the model's opinion)     the model  │
 │   2. execute side effects (tools), if any                       │
 │   3. compute the NEXT state from (state, action, result)        │
 │   4. append an immutable transition record                      │
 └────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼  persist, then loop
              terminal state? → return
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| State type | The single source of truth | Pydantic model, one DB row | Fields the model can write directly |
| Transition table | Which actions are legal in which state | Dict or explicit function | Left implicit, so illegal transitions happen |
| Action type | What the model may propose | Discriminated union | Free-form strings |
| Reducer | `(state, action, result) → state` | Pure function | Side effects inside it, making it untestable |
| Effect executor | Runs tools; returns results to the reducer | Separate from the reducer | Merged with reduction, so you cannot replay |
| Transition log | Append-only record of every change | DB table | Only the latest state stored — no audit |
| State renderer | State → prompt text | Template | Dumping raw JSON; or letting the model see fields it must not set |
| Persistence | Survive crash, deploy, compaction | DB write per transition | In-memory only |

## 4. Data flow

1. Load state (or create it).
2. Render a **view** of the state into the prompt — only what the model needs to decide.
3. Model returns one typed `Action`.
4. Validate the action against the transition table for the current status. Illegal → return an
   explanatory error to the model as a tool result; **state does not change**.
5. Execute side effects for legal actions. Effects are outside the reducer so the reducer stays
   pure and replayable.
6. Reducer computes the next state from `(state, action, effect_result)`.
7. Persist new state **and** the transition record atomically.
8. If terminal, return. Otherwise loop.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal, Annotated, Union
from datetime import datetime

Status = Literal["intake", "gathering", "deciding", "awaiting_review", "executing", "closed"]

class State(BaseModel):
    """The single source of truth. Not the transcript."""
    id: str
    tenant_id: str
    status: Status
    facts: dict[str, str] = Field(default_factory=dict, description="Verified, with provenance.")
    decision: str | None = None
    artifacts: list[str] = Field(default_factory=list)
    step: int = 0
    cost_usd: float = 0.0

# Actions are a closed set. The model cannot invent one.
class Lookup(BaseModel):
    kind: Literal["lookup"] = "lookup"
    entity: str

class RecordFact(BaseModel):
    kind: Literal["record_fact"] = "record_fact"
    key: str
    value: str
    source: str = Field(description="Where this came from. Required — no unsourced facts.")

class Decide(BaseModel):
    kind: Literal["decide"] = "decide"
    outcome: str
    rule_id: str

class RequestReview(BaseModel):
    kind: Literal["request_review"] = "request_review"
    reason: str

Action = Annotated[Union[Lookup, RecordFact, Decide, RequestReview],
                   Field(discriminator="kind")]

# The transition table IS the workflow. It lives in code, reviewable and diffable.
LEGAL: dict[Status, set[str]] = {
    "intake":          {"lookup", "record_fact"},
    "gathering":       {"lookup", "record_fact", "decide", "request_review"},
    "deciding":        {"decide", "request_review"},
    "awaiting_review": set(),          # only a human moves it out of here
    "executing":       set(),
    "closed":          set(),
}

class Transition(BaseModel):
    at: datetime
    from_status: Status
    to_status: Status
    action_kind: str
    actor: Literal["agent", "human", "system"]
    detail: str
```

## 6. Reference implementation

```python
from dataclasses import replace

class IllegalTransition(Exception): ...

def reduce(state: State, action: Action, effect: dict | None) -> tuple[State, Transition]:
    """PURE. No IO, no side effects, no clock. This is what makes it testable and replayable."""
    if action.kind not in LEGAL[state.status]:
        raise IllegalTransition(
            f"Action {action.kind!r} is not allowed while status is {state.status!r}. "
            f"Allowed here: {sorted(LEGAL[state.status]) or 'none — a human must act'}.")

    s = state.model_copy(deep=True)
    s.step += 1
    to_status = s.status

    match action:
        case Lookup():
            # A lookup does not change status; it only makes results available.
            pass
        case RecordFact():
            s.facts[action.key] = f"{action.value} [source: {action.source}]"
            if s.status == "intake" and required_facts_present(s.facts):
                to_status = "gathering"
        case Decide():
            if not rule_exists(action.rule_id):
                raise IllegalTransition(
                    f"Rule {action.rule_id!r} does not exist. Cite a real rule id.")
            s.decision = f"{action.outcome} (rule {action.rule_id})"
            to_status = "awaiting_review" if needs_review(s) else "executing"
        case RequestReview():
            to_status = "awaiting_review"

    s.status = to_status
    return s, Transition(at=now(), from_status=state.status, to_status=to_status,
                         action_kind=action.kind, actor="agent",
                         detail=action.model_dump_json())


async def step(state: State, model, tools) -> State:
    """Effects live HERE, outside the reducer."""
    view = render_state_for_prompt(state)          # a view, not the raw state
    action = await model.propose_action(view, allowed=sorted(LEGAL[state.status]))

    effect = await execute_effect(action, tools) if has_effect(action) else None

    try:
        new_state, transition = reduce(state, action, effect)
    except IllegalTransition as e:
        # The model gets a correction, not a crash. State is untouched.
        await model.observe(f"Rejected: {e}")
        return state

    async with db.transaction():                   # state and log move together or not at all
        await db.save_state(new_state)
        await db.append_transition(state.id, transition)
    return new_state
```

Testing becomes ordinary, because the reducer is pure:

```python
def test_cannot_decide_before_facts_are_gathered():
    s = State(id="1", tenant_id="t", status="intake")
    with pytest.raises(IllegalTransition):
        reduce(s, Decide(outcome="approve", rule_id="R1"), None)

def test_decision_requires_a_real_rule():
    s = State(id="1", tenant_id="t", status="deciding")
    with pytest.raises(IllegalTransition):
        reduce(s, Decide(outcome="approve", rule_id="NOPE"), None)

def test_replay_is_deterministic():
    s = State(id="1", tenant_id="t", status="intake")
    for a, e in recorded_run:
        s, _ = reduce(s, a, e)
    assert s.status == "closed"        # same input, same output, always
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Status granularity | 4–8 states | Auditability vs ceremony | More states when different people own different stages |
| Action set | closed union, 4–8 kinds | What the model may propose | Keep small; each action is a contract |
| Reducer purity | pure, no IO | Testability and replay | Never relax this |
| State view | subset of state | Prompt size and safety | Never render fields the model must not influence |
| Persistence | every transition | Durability | Always — batching loses the audit trail |
| Illegal action | returned to the model as text | Recovery | Never crash; the model can correct itself |
| Transition log | append-only, immutable | Audit and replay | Non-negotiable where decisions matter |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Agent claims a step is done that never ran | State lives in the transcript | Compare state store to the transcript | Only the reducer writes state |
| State is inconsistent after a crash | State and log written separately | Orphaned transitions | One transaction for both |
| Cannot answer "how many are awaiting review" | State is text | Try the query | Typed status column, indexed |
| Model skips a required stage | No transition table | Illegal sequences in the log | Explicit `LEGAL` map |
| Reducer untestable | Side effects inside it | It needs mocks to run | Effects outside; reducer pure |
| Injected text changed the workflow | Model output written directly to state | Audit unexpected status jumps | Typed actions validated against the table |
| Replay produces a different result | Reducer reads a clock or does IO | Replay a recorded run twice | Pass time and effect results in as arguments |
| Prompt grew huge as state accumulated | Whole state rendered every turn | Prompt token growth per step | Render a view; summarise history |

## 9. Anti-patterns

- **State in the transcript.** The origin of most "the agent lost track" reports.
- **Letting the model set the status directly.** It becomes a suggestion, not a state machine.
- **Side effects inside the reducer.** Kills purity, testability, and replay in one move.
- **Free-form action strings.** `{"action": "do the thing"}` cannot be validated.
- **Implicit transitions.** If the legal moves are not written down, illegal ones will happen.
- **Crashing on an illegal action.** Return it as an error the model can act on.
- **Storing only the latest state.** You lose the audit trail and the ability to replay.
- **Rendering the whole state into the prompt.** Render only what the decision needs.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Illegal action rate | Rejected / proposed | < 5% | > 20% (prompt does not match the machine) |
| Replay determinism | Recorded runs reproducing the same final state | 100% | < 100% |
| Reducer test coverage | Branch coverage of transitions | ≥ 95% | < 80% |
| Orphaned transitions | Log entries with no matching state | 0 | ≥ 1 |
| State-store queries | Operational questions answerable by SQL | All of them | Any that require reading transcripts |
| Prompt growth per step | Tokens added per transition | Bounded | Unbounded |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | State in the transcript. Fine for one-shot tasks. |
| v1 | Agent loses track, or you need to query progress | Typed state object, persisted per step |
| v2 | Illegal sequences occur | Explicit transition table; typed action union |
| v3 | Audit or debugging needed | Append-only transition log; pure reducer; replay |
| v4 | Runs must survive deploys and interrupts | Checkpointing — see [framework-selection.md](framework-selection.md) |
| v5 | Multi-day workflows | Durable workflow engine driving the outer loop |

## 12. Build checklist

- [ ] State is a typed object in a store, never the conversation transcript.
- [ ] Status is a closed enum, indexed and queryable.
- [ ] Actions are a closed discriminated union; the model cannot invent one.
- [ ] A `LEGAL` transition table exists in code and is reviewed like business logic.
- [ ] The reducer is pure: no IO, no clock, no randomness.
- [ ] Side effects run outside the reducer; results are passed in as arguments.
- [ ] Illegal actions return an explanatory error to the model; state is unchanged.
- [ ] State and transition log are written in one transaction.
- [ ] The transition log is append-only.
- [ ] Only the model's *proposals* are model-controlled; every commit is code.
- [ ] The prompt receives a rendered view, not the raw state.
- [ ] A replay test proves a recorded run reproduces the same final state.

## 13. Related

- [agent-loop.md](agent-loop.md) — the loop this sits inside
- [framework-selection.md](framework-selection.md) — when to let a graph framework own this
- [human-in-the-loop.md](human-in-the-loop.md) — states only a human can leave
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — transitions as eval input
