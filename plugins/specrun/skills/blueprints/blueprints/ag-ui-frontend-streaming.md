+++
id = "ag-ui-frontend-streaming"
title = "AG-UI frontend streaming"
use_when = "The interface has to show what the agent is doing while it works: tokens, tool calls, thinking traces, interruptions"
pack = "agent protocols"
verified_at = 2026-08-12
stale_after = "90d"
+++

# AG-UI — Streaming Agent Work to a Frontend

<!-- verified: 2026-08-12 -->

> An event protocol between an agent and a user interface: tokens, tool calls, thinking traces,
> shared state diffs, generative UI, and interrupts — so the user can watch and intervene.

**Tier:** intermediate
**Use when:** the UI must show *what the agent is doing*, not just the final answer; the user
approves or edits mid-run; agent and app share state.
**Avoid when:** a plain chat UI that only needs tokens streamed — SSE is enough and simpler.
**Cost profile:** free on the wire. Saves the weeks normally spent reinventing interrupts, state
sync, and tool-call rendering.

---

## 1. Problem it solves

Agent UIs need things a request/response API never had to express: which tool is running right
now, a plan the user can edit before it executes, an approval gate in the middle of a run, and
state that both sides mutate.

Every team building this hand-rolls the same websocket message format, and every one of them
gets the same three things wrong: no way to interrupt cleanly, state that drifts between client
and server, and no distinction between "the agent is thinking" and "the agent is answering".

AG-UI standardises that layer: an open, lightweight, **event-based** protocol over ordinary web
transports (HTTP, WebSockets), framework-agnostic on both ends.

**Check first:** if your UI shows a chat bubble and nothing else, plain SSE is the right
answer. Adopt AG-UI when the UI needs to show *work*, not just *output*.

## 2. Shape

```
   FRONTEND                                          AGENT BACKEND
      │                                                    │
      │  user message  ────────────────────────────────────▶
      │                                                    │
      │◀── trace events ───── "reasoning about the request"│  thinking visible
      │◀── chat/streaming ─── tokens as they generate      │
      │◀── tool events ────── calling search_orders(...)   │  which tool, live
      │◀── tool events ────── result: 5 rows               │
      │◀── state events ───── diff: {status: "deciding"}   │  event-sourced diff
      │◀── ui events ──────── render <RefundPreview .../>  │  generative UI
      │                                                    │
      │◀── interrupt ──────── approve / edit / retry?      │  agent PAUSES
      │ ── user decision ──────────────────────────────────▶
      │                                                    │
      │◀── chat/streaming ─── final answer                 │
      │                                                    │
   ┌──┴──────────────────────────────────────────────────┴──┐
   │ SHARED TYPED STORE — streamed event-sourced diffs,      │
   │ with conflict resolution. Both sides may mutate.        │
   └─────────────────────────────────────────────────────────┘
```

## 3. Components

| Event category | Carries | UI does | Failure if missing |
|---|---|---|---|
| Chat / streaming | Message and token deltas | Renders the answer progressively | Feels frozen |
| Tool events | Tool call started, arguments, result, streamed output | Shows what is happening | User sees a spinner and assumes it hung |
| Trace events | Thinking steps, intermediate reasoning | Optional "show work" panel | No insight into a wrong answer |
| State events | Event-sourced diffs of a typed shared store | Updates the app's own state | Client and server drift |
| UI events | Generative UI renders, frontend tool-call handoffs | Renders components the agent chose | Everything degrades to text |
| Interrupts | Pause, approve, edit, retry, escalate | Presents a decision | Irreversible actions run unreviewed |
| Custom events | Anything app-specific | Whatever you need | Forced to abuse another channel |

Transport is ordinary web plumbing — HTTP and WebSockets — used as an abstraction layer for
bidirectional communication.

**Exact event names are version-specific.** Read the current spec before implementing; the
categories above are stable, individual names are not.

## 4. Data flow

1. Frontend sends a user message over the AG-UI channel.
2. Backend emits trace events as the agent reasons — the UI may show or hide them.
3. Token deltas stream as the answer forms.
4. Tool events bracket each tool call, so the UI can name the current activity.
5. State changes stream as **diffs** into a typed store both sides share; conflicts resolve per
   the protocol's rules rather than last-write-wins.
6. When the agent needs a decision, it emits an **interrupt** and pauses. The UI renders the
   choice; the user approves, edits, retries, or escalates; the answer flows back and the agent
   resumes.
7. Generative UI events let the agent render real components — a refund preview, a diff, a
   confirmation card — rather than describing them in prose.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal, Any

class AgentUIState(BaseModel):
    """The typed store shared with the frontend. Keep it SMALL and presentational —
    it is not your internal agent state."""
    status: Literal["idle", "thinking", "calling_tool", "awaiting_user", "done", "error"]
    current_tool: str | None = None
    plan: list[str] = Field(default_factory=list, description="User-editable before execution.")
    step: int = 0
    cost_usd: float = 0.0
    trace_id: str

class Interrupt(BaseModel):
    """The agent stops here until the user answers."""
    interrupt_id: str
    kind: Literal["approve", "edit", "choose", "credentials"]
    title: str
    preview: str = Field(description="What will happen, rendered for a human. "
                                     "A diff or the literal payload — never raw JSON args.")
    options: list[str] = Field(default_factory=list)
    reversible: bool
    timeout_s: int = 300

class InterruptResponse(BaseModel):
    interrupt_id: str
    decision: Literal["approve", "reject", "edit", "timeout"]
    edited: dict[str, Any] | None = None
```

Keep the shared state separate from your internal agent state
([state-machine-reducer.md](state-machine-reducer.md)). The UI store is a **projection**:
small, presentational, safe to expose. Your reducer's state stays server-side.

## 6. Reference implementation

The backend pattern, expressed against the event categories:

```python
async def run_with_ui(task: str, ui, agent):
    """`ui` emits AG-UI events. Names below are illustrative — use the current spec's."""
    await ui.state_diff({"status": "thinking", "trace_id": trace_id})

    plan = await agent.plan(task)
    await ui.state_diff({"plan": plan})

    # A plan the user can edit before anything executes is the highest-value interrupt
    # in this whole protocol.
    resp = await ui.interrupt(Interrupt(
        interrupt_id=new_id(), kind="edit", title="Plan",
        preview="\n".join(f"{i+1}. {s}" for i, s in enumerate(plan)),
        reversible=True))
    if resp.decision == "reject":
        await ui.state_diff({"status": "idle"})
        return
    if resp.decision == "edit":
        plan = resp.edited["plan"]

    for step in plan:
        await ui.state_diff({"status": "calling_tool", "current_tool": step.tool, "step": +1})
        await ui.tool_start(step.tool, step.args)

        if step.irreversible:
            # Gate BEFORE execution, with a human-readable preview.
            r = await ui.interrupt(Interrupt(
                interrupt_id=new_id(), kind="approve", title=f"Confirm: {step.tool}",
                preview=render_preview(step),      # a diff or the literal payload
                reversible=False, timeout_s=300))
            if r.decision in ("reject", "timeout"):
                # Refusal returns to the AGENT as context, not as an exception.
                await agent.observe(f"User {r.decision}ed {step.tool}. Do not retry; adapt.")
                continue

        result = await execute(step)
        await ui.tool_end(step.tool, summarize(result))

    await ui.state_diff({"status": "done"})
    async for token in agent.stream_answer():
        await ui.token(token)
```

Two details carry most of the value: **the preview is human-readable** (a diff, a rendered email —
never raw arguments), and **a rejection returns to the agent as context** so it can adapt rather
than crash or retry blindly.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Trace events | off by default, user-toggleable | Noise vs insight | On for internal tools, off for customers |
| Shared state size | small, presentational | Sync cost | Never mirror internal agent state |
| Interrupt timeout | 300 s | Liveness | Timeout must mean reject, never auto-approve |
| Generative UI | opt-in per component | Surface area | Whitelist which components the agent may render |
| Transport | per your stack | Latency, reconnection | WebSockets for bidirectional; HTTP/SSE if one-way suffices |
| State conflicts | protocol resolution | Correctness | Never last-write-wins on user edits |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| UI and agent state diverge | State pushed as snapshots, or last-write-wins | User edits vanish | Event-sourced diffs with real conflict resolution |
| User cannot stop a wrong run | No interrupt support | Support requests to "kill it" | Interrupt events with a cancel path |
| Approvals are rubber-stamped | Preview shows raw arguments | Time-to-approve under 3 s | Render a diff or the literal payload |
| Rejection crashes the run | Treated as an exception | Errors after every rejection | Return the refusal to the agent as context |
| Frontend leaks internal state | Shared store mirrors agent internals | Read what the client receives | Projection only: small and presentational |
| Agent renders arbitrary components | No whitelist | Unexpected UI | Whitelist renderable components |
| Interrupt hangs forever | No timeout | Runs stuck awaiting user | Timeout → reject |
| Reconnect loses the run | No resumption | Refresh kills progress | Persist run state server-side; resume by trace id |

## 9. Anti-patterns

- **Hand-rolling this.** Interrupts, state diffs, and tool rendering are exactly the tedious parts,
  and they are already specified.
- **Adopting it for a plain chat UI.** If you only stream tokens, SSE is simpler.
- **Mirroring internal agent state to the client.** Ship a projection; the reducer's state stays
  on the server.
- **Previews that show raw arguments.** `{"to": "...", "amount": 129}` is not a preview.
- **Auto-approving on interrupt timeout.** Converts an absent user into a silent yes.
- **Raising on rejection.** The agent should learn it was refused and adapt.
- **Letting the agent render any component.** Whitelist.
- **No resumption after reconnect.** Users refresh; runs should survive it.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Time to first visible event | User message → first UI update | < 500 ms | > 1.5 s |
| State divergence | Sessions where client and server disagree | 0 | ≥ 1 |
| Interrupt response rate | Answered / raised | ≥ 90% | < 70% |
| Time-to-approve p50 | Decision latency | 10 s – 2 min | < 3 s (rubber-stamping) |
| Interrupt timeout rate | Timed out / raised | < 5% | > 15% |
| Run resumption success | Runs surviving a reconnect | ≥ 95% | < 80% |
| Abandoned runs | Closed before terminal state | < 10% | > 25% |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | Final answer only, no streaming |
| v1 | Waits feel broken | Token streaming over SSE |
| v2 | Users ask "what is it doing?" | Tool events; AG-UI becomes worth adopting |
| v3 | Irreversible actions in-run | Interrupts with human-readable previews |
| v4 | App and agent share state | Typed shared store with event-sourced diffs |
| v5 | Rich agent experiences | Generative UI from a whitelisted component set |

## 12. Build checklist

- [ ] Confirmed the UI needs more than token streaming; otherwise plain SSE was chosen.
- [ ] The current AG-UI spec was read; event names come from it, not from memory.
- [ ] The shared store is a small presentational projection, not internal agent state.
- [ ] State updates are diffs with defined conflict resolution.
- [ ] Interrupts exist for every irreversible action.
- [ ] Interrupt previews are diffs or literal payloads, never raw arguments.
- [ ] Interrupt timeout means reject.
- [ ] Rejections return to the agent as context; the run adapts instead of crashing.
- [ ] Renderable components are whitelisted.
- [ ] Runs persist server-side and resume after a reconnect.
- [ ] Trace id is sent to the client in the first event.

## 13. Related

- [agent-protocols-overview.md](agent-protocols-overview.md) — when AG-UI is the right boundary
- [human-in-the-loop.md](human-in-the-loop.md) — what the interrupts enforce
- [state-machine-reducer.md](state-machine-reducer.md) — the state being projected
- [observability-tracing.md](observability-tracing.md) — the trace id shown to users
