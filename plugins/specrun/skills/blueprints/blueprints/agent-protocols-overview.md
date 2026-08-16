+++
id = "agent-protocols-overview"
title = "Agent protocols overview"
use_when = "Choosing which wire protocol fits — tools, agent-to-agent delegation, frontend streaming — when an agent has to talk to something outside its own process"
pack = "agent protocols"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Agent Protocols — Overview

<!-- verified: 2026-08-12 -->

> Which wire protocol solves which problem — tools, agent-to-agent delegation, frontend
> streaming — and which ones are mature enough to build on today.

**Tier:** intermediate
**Use when:** an agent must talk to something outside its own process — a tool, another team's
agent, or a user interface.
**Avoid when:** everything lives in one codebase. A function call beats a protocol.
**Cost profile:** free to choose. Expensive to pick a immature one and own the drift.

---

## 1. Problem it solves

"Agent protocol" now means at least four different things, and teams adopt the wrong one because
the names blur. The distinctions are actually clean once you ask **who is on the other end**:

| Other end | Protocol | Status |
|---|---|---|
| A tool or data source | **MCP** | Most widely adopted; the default |
| Another autonomous agent, possibly another company's | **A2A** | v1.0, Linux Foundation; real traction |
| A user interface that must show the agent working | **AG-UI** | Adopted, framework-agnostic |
| A UI whose *state* the agent co-owns | **A2UI** | More a design pattern than a settled standard |
| Developer tooling — debuggers, dashboards | **AP2** | Tooling-oriented |
| Permissions and trust across organisational boundaries | **X42** | Still maturing; enterprise/compliance contexts |

**The practical shortlist for 2026 is MCP + A2A + AG-UI.** The rest are worth knowing by name so
you recognise them in an architecture diagram, and worth verifying before adopting.

## 2. Shape — where each one sits

```
   ┌──────────────────────────────────────────────────────────────┐
   │  USER INTERFACE                                               │
   │    ▲  AG-UI  — events: tokens, tool calls, state diffs,       │
   │    │          thinking traces, interrupts (approve/edit/retry)│
   └────┼─────────────────────────────────────────────────────────┘
        │
   ┌────┴─────────────────────────────────────────────────────────┐
   │  YOUR AGENT                                                   │
   │    │                                    ▲                     │
   │    │ MCP                                │ A2A                 │
   │    ▼                                    ▼                     │
   │  ┌──────────────┐              ┌────────────────────┐        │
   │  │ tools, data, │              │ ANOTHER AGENT      │        │
   │  │ prompts      │              │ own model, own     │        │
   │  │ (you own the │              │ tools, own team    │        │
   │  │  server)     │              │ or company         │        │
   │  └──────────────┘              └────────────────────┘        │
   └──────────────────────────────────────────────────────────────┘

   MCP  = "give me a capability"      — you orchestrate
   A2A  = "achieve this outcome"      — they orchestrate, you get a task handle
   AG-UI= "here is what I am doing"   — the user watches and intervenes
```

## 3. Components — how to tell them apart

| Question | MCP | A2A |
|---|---|---|
| What crosses the wire | A tool call and its result | A task with a goal |
| Who plans | You | The remote agent |
| Duration | One request | Long-running, with a lifecycle |
| Discovery | `tools/list` | Agent Card at `/.well-known/agent-card.json` |
| The unit | Tool | Skill (advertised capability) |
| Opacity | You see the schema | The remote agent's internals are deliberately hidden |
| Trust | You granted a credential | Two parties with separate auth domains |

**The decision rule:** if you would be comfortable specifying the exact arguments, it is a tool —
use MCP. If you want to hand over an *outcome* and let the other side decide how, it is A2A.

## 4. Data flow — a system using all three

1. User asks something in the UI.
2. Your agent streams its work over **AG-UI**: thinking, tool calls, partial output. The user can
   interrupt, approve, or edit mid-run.
3. It calls your own tools over **MCP** — database, knowledge base, internal actions.
4. It needs something outside its competence, so it discovers a specialist agent's Agent Card,
   submits a task over **A2A**, and subscribes to that task's updates.
5. The remote agent works, possibly for minutes, and returns artifacts.
6. Your agent folds the result into its own answer, still streaming over AG-UI.

Each protocol handles one boundary. Mixing them up — using MCP for another team's autonomous
agent, or hand-rolling a websocket instead of AG-UI — is where the pain comes from.

## 5. Contracts

```python
from pydantic import BaseModel
from typing import Literal

class ProtocolChoice(BaseModel):
    """Write this down for each external boundary before implementing anything."""
    boundary: str                       # "our order database", "legal review agent", "web app"
    other_side: Literal["tool_or_data", "autonomous_agent", "user_interface"]
    protocol: Literal["mcp", "a2a", "ag-ui", "plain_http", "none"]
    why: str
    auth_domain: Literal["same", "different"]
    long_running: bool
```

If `other_side` is `tool_or_data` → MCP. If `autonomous_agent` **and** `auth_domain` is
`different` → A2A. If `user_interface` and the agent streams work → AG-UI. If none of those fit,
plain HTTP is a legitimate answer; do not adopt a protocol for its own sake.

## 6. Reference implementation

The decision, made explicitly, at the start of a design:

```markdown
## External boundaries

| Boundary | Other side | Protocol | Why |
|---|---|---|---|
| Orders database | tool/data | MCP | We own it; we specify the exact queries |
| Help-centre corpus | tool/data | MCP | Same — a search capability we control |
| Compliance review agent (Legal team) | autonomous agent | A2A | Different team, different auth domain, they decide how to review |
| Customer web app | user interface | AG-UI | Users must see progress and approve refunds mid-run |
| Payment provider | tool/data | plain HTTP | A stable REST API; a protocol adds nothing |
```

That table belongs in the project README. Most protocol mistakes are made by never writing it.

## 7. Configuration knobs

| Knob | Default | Change it when |
|---|---|---|
| Protocol per boundary | decided explicitly | Never adopt one by default |
| MCP version | current spec revision, pinned | Verify before building — it changed materially in 2026 |
| A2A adoption | only across trust boundaries | In-process specialists are sub-agents, not A2A peers |
| AG-UI adoption | when the UI shows agent work | A simple chat UI can use plain SSE |
| Emerging protocols | know the names, verify before use | A2UI, AP2, X42 — check maturity first |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Wrapped another team's agent as an MCP tool | Treated an outcome as a function call | Their agent needs context you cannot supply | Use A2A: hand over the goal, not the arguments |
| Built A2A for an in-process specialist | Protocol where a function call would do | Latency and complexity with no isolation benefit | Sub-agent in the same process |
| Hand-rolled websocket protocol for the UI | Did not know AG-UI existed | Reinventing interrupts and state diffs | Adopt AG-UI or accept plain SSE |
| Adopted an immature protocol | Chose by novelty | Spec churn breaks you repeatedly | Verify adoption before building |
| MCP client broke after a client upgrade | Pre-2026-07-28 assumptions | Connection failures | Migrate; see the MCP blocks |
| Cross-org agent call has no accountability | No auth story at the boundary | Cannot attribute an action | A2A security schemes; signed Agent Cards |

## 9. Anti-patterns

- **Using MCP for another organisation's autonomous agent.** You end up specifying arguments for
  work you do not understand.
- **Using A2A inside one process.** All the cost of a protocol, none of the isolation benefit.
- **Hand-rolling a UI streaming protocol.** Interrupts, state diffs, and tool-call rendering are
  exactly the parts that are tedious and already specified.
- **Adopting a protocol before writing the boundary table.** The table takes ten minutes and
  prevents the two mistakes above.
- **Trusting a remote Agent Card without verifying its signature.** It is an untrusted document
  describing capabilities and required credentials.
- **Assuming the protocol handles trust.** Protocols carry credentials; they do not decide what a
  remote agent may do with yours.

## 10. Metrics and SLOs

| Metric | Target |
|---|---|
| Boundaries with an explicit documented protocol choice | 100% |
| Protocol versions pinned | 100% |
| Cross-boundary calls with attributable identity | 100% |
| Remote Agent Cards with verified signatures | 100% |
| Hand-rolled protocols where a standard exists | 0 |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | One process | Function calls. No protocol. |
| v1 | Capabilities shared across apps or teams | MCP servers |
| v2 | The UI must show agent work | AG-UI, or plain SSE for simple chat |
| v3 | Another team's agent owns a step | A2A with signed Agent Cards |
| v4 | Cross-organisation | A2A + mTLS/OAuth, scoped skills, audit at the boundary |
| v5 | Many agents, many owners | A registry of Agent Cards; policy at the gateway |

## 12. Build checklist

- [ ] A boundary table exists in the project README, one row per external boundary.
- [ ] Each row states the protocol and the reason.
- [ ] MCP is used only for tools and data you can specify precisely.
- [ ] A2A is used only across genuine trust boundaries, not for in-process specialists.
- [ ] AG-UI (or an explicit decision to use plain SSE) covers the UI boundary.
- [ ] Every protocol version is pinned and dated.
- [ ] Remote Agent Card signatures are verified before use.
- [ ] Current spec revisions were checked on the web, not recalled.

## 13. Related

- [a2a-agent-to-agent.md](a2a-agent-to-agent.md) — delegating to another agent
- [ag-ui-frontend-streaming.md](ag-ui-frontend-streaming.md) — showing agent work in a UI
- [mcp-protocol-overview.md](mcp-protocol-overview.md) — tools and data
- [framework-selection.md](framework-selection.md) — the runtime these plug into
