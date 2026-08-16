+++
id = "agent-loop"
title = "Agent loop"
use_when = "Building the loop that calls a model, runs the tools it asks for and repeats until it stops; or an agent runs away, loops, or will not stop on its own"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Agent Loop (Tool-Use Loop)

> A `while` loop that sends conversation state to an LLM, executes any tool calls it returns, appends the results, and repeats until the model stops calling tools.

**Tier:** foundational
**Use when:** the number of steps is unknown at design time; the model must decide what to do next based on what it just learned; the task has a verifiable end state.
**Avoid when:** the steps are fixed and known — use [prompt chaining](prompt-chaining.md), which is cheaper, faster, and debuggable.
**Cost profile:** N+1 LLM calls for N tool calls. Context grows monotonically. p95 latency is unbounded without a step cap.

---

## 1. Problem it solves

Fixed pipelines break when the required steps depend on intermediate results. "Find the bug in this repo" cannot be decomposed in advance: which files to read depends on what the first file said. The agent loop moves control flow from your code into the model, at the cost of predictability and a linear-to-quadratic token bill.

Everything else in this folder is a constraint bolted onto this loop to buy back predictability.

## 2. Shape

```
                   ┌──────────────────────────────────┐
                   │            messages[]            │  ← grows every turn
                   └───────────────┬──────────────────┘
                                   │ full history + tool schemas
                                   ▼
   ┌────────────┐         ┌─────────────────┐
   │ system     │────────▶│      LLM        │
   │ prompt     │         └────────┬────────┘
   └────────────┘                  │ assistant message
                                   ▼
                          ┌────────────────┐
                     no   │ has tool_calls?│
                 ┌────────┤                │
                 │        └───────┬────────┘
                 ▼                │ yes
           ┌──────────┐           ▼
           │  RETURN  │   ┌───────────────┐  args (validated)  ┌──────────────┐
           └──────────┘   │  dispatcher   │───────────────────▶│  tool impl   │
                          └───────▲───────┘                    └──────┬───────┘
                                  │  tool_result (truncated)          │
                                  └───────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| System prompt | Role, constraints, tool-selection policy, stop criteria | Static string + injected runtime facts | Vague stop criteria → infinite loop |
| Tool registry | Name → (JSON Schema, handler) | Dict, decorator registry, MCP client | Overlapping tool descriptions → wrong tool picked |
| Dispatcher | Validate args, route, catch, serialise result | Pydantic + try/except | Raw exception leaks stack trace into context |
| Message store | Ordered turn history | List of dicts; DB row for durability | Unbounded growth → context overflow |
| Step governor | Caps iterations, wall-clock, token spend | Counter + deadline | Missing → runaway cost |
| Result truncator | Bounds tool output size | Head/tail slice + "N bytes elided" | Silent truncation mid-JSON → model misparses |

## 4. Data flow

1. Build `messages = [system] + history + [user]`.
2. Call LLM with `tools=<schemas>`; receive assistant message.
3. If no `tool_calls` → return the text. **Terminal.**
4. For each `tool_call` `‖`: validate args against schema → execute → serialise.
5. Append the assistant message, then one `tool_result` message per call, **in the same order and with matching IDs**.
6. Increment step counter; if over budget → inject a budget-exhausted system note and force a final answer.
7. Goto 2.

## 5. Contracts

```python
from typing import Any, Callable, Protocol
from pydantic import BaseModel

class ToolResult(BaseModel):
    tool_call_id: str
    content: str                  # always a string; serialise structured data yourself
    is_error: bool = False

class Tool(Protocol):
    name: str                     # ^[a-z0-9_]{1,64}$
    description: str              # when to use AND when not to
    input_schema: dict[str, Any]  # JSON Schema, additionalProperties: false
    def run(self, **kwargs: Any) -> str: ...

class AgentConfig(BaseModel):
    max_steps: int = 20
    max_wall_clock_s: float = 300.0
    max_tool_output_chars: int = 8_000
    parallel_tools: bool = True
```

## 6. Reference implementation

Provider-agnostic core; the Anthropic Messages API shape is used for concreteness.

```python
import json, time, concurrent.futures as cf
from anthropic import Anthropic

client = Anthropic()

def truncate(s: str, limit: int) -> str:
    if len(s) <= limit:
        return s
    keep = limit // 2
    return f"{s[:keep]}\n\n...[{len(s) - limit} chars elided]...\n\n{s[-keep:]}"

def run_agent(user_input: str, tools: dict[str, Tool], cfg: AgentConfig,
              system: str) -> str:
    messages = [{"role": "user", "content": user_input}]
    schemas = [{"name": t.name, "description": t.description,
                "input_schema": t.input_schema} for t in tools.values()]
    deadline = time.monotonic() + cfg.max_wall_clock_s

    for step in range(cfg.max_steps):
        over_budget = time.monotonic() > deadline
        resp = client.messages.create(
            model="<MODEL_ID>",
            max_tokens=4096,
            system=system + ("\n\nBudget exhausted. Answer now with what you have."
                             if over_budget else ""),
            tools=[] if over_budget else schemas,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})

        calls = [b for b in resp.content if b.type == "tool_use"]
        if not calls:
            return "".join(b.text for b in resp.content if b.type == "text")

        def execute(block):
            try:
                tool = tools[block.name]
            except KeyError:
                return {"type": "tool_result", "tool_use_id": block.id,
                        "content": f"Unknown tool {block.name!r}. "
                                   f"Available: {sorted(tools)}", "is_error": True}
            try:
                out = tool.run(**block.input)
                return {"type": "tool_result", "tool_use_id": block.id,
                        "content": truncate(str(out), cfg.max_tool_output_chars)}
            except Exception as e:
                # Actionable message, never a stack trace.
                return {"type": "tool_result", "tool_use_id": block.id,
                        "content": f"{type(e).__name__}: {e}", "is_error": True}

        if cfg.parallel_tools and len(calls) > 1:
            with cf.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(execute, calls))
        else:
            results = [execute(c) for c in calls]

        messages.append({"role": "user", "content": results})

    return "Step budget exhausted without a final answer."
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `max_steps` | 20 | Hard iteration cap | Raise for repo-wide refactors; lower to 5 for user-facing chat |
| `max_tool_output_chars` | 8 000 | Bound per tool result | Lower when many parallel calls; raise for single-file reads |
| `parallel_tools` | true | Concurrent execution of independent calls | Disable when tools mutate shared state |
| `temperature` | 0–0.3 | Tool-selection determinism | Keep low; agents are not creative writing |
| Tool count | ≤ 15 | Selection accuracy | Above ~20, route to sub-agents with disjoint toolsets |
| History policy | full | Context growth | Switch to compaction past ~50% of window |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Same tool, same args, repeatedly | Result doesn't answer the model's question; no progress signal | Hash `(name, args)`; alert on repeat | Return the hash-repeat as an error: "identical call already returned X; try a different approach" |
| Loop never terminates | Stop criteria absent from system prompt | Steps hit cap | State the terminal condition explicitly: "when you have the answer, reply with text and no tool call" |
| Context overflow mid-run | Tool results unbounded | Token count per turn | Truncate + [compaction](context-engineering.md) |
| Hallucinated tool name / args | Schemas ambiguous or overlapping | `is_error` rate by tool | Rewrite descriptions to be mutually exclusive; `additionalProperties: false` |
| Correct plan, wrong execution | Model can't see the effect of its actions | Trace review | Make tools return observable state, not just `"ok"` |
| Cost spike on one request | Retry storm inside tools | Tokens per conversation histogram | Budget guard on cumulative tokens, not just steps |
| Model ignores a tool entirely | Description doesn't match user vocabulary | Tool-use distribution | Put trigger words from real user queries in the description |

## 9. Anti-patterns

- **Tool-per-API-endpoint.** Mirroring 40 REST endpoints as 40 tools destroys selection accuracy. Design tools around *tasks the agent performs*, not around your service boundaries. See [tool-design.md](tool-design.md).
- **Silent error swallowing.** Returning `""` on exception makes the model retry blindly. Errors must be returned to the model as text it can act on.
- **Stuffing state into the system prompt each turn.** It defeats prompt caching. Put mutable state in a tool result or the last user turn; keep the system prefix byte-stable.
- **Loop with no cap "because the model knows when to stop".** It does not, reliably. Always cap.
- **Reordering or dropping tool_result blocks.** Every `tool_use` needs exactly one matching `tool_result` in the next turn, or the API rejects the request.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Task success rate | Graded end-to-end on a fixed eval set | ≥ 85% | < 80% |
| Steps per task | p50 / p95 iterations | p95 ≤ 0.6 × `max_steps` | p95 ≥ cap |
| Tool error rate | `is_error` / total calls | < 3% | > 10% |
| Loop-detection rate | Runs with a repeated `(name, args)` | < 1% | > 5% |
| Cost per task | USD p50 / p95 | Set per product | p95 > 3× p50 |
| Cache hit rate | Cached input tokens / input tokens | > 70% | < 40% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 — bare loop | — | Loop + 3–5 tools + step cap |
| v1 — governed | Cost or latency complaints | Budgets, truncation, loop detection, structured tracing |
| v2 — context-managed | Tasks exceed one context window | [Compaction, memory files, sub-agents](context-engineering.md) |
| v3 — decomposed | > 20 tools, or distinct task families | [Routing](routing.md) → [orchestrator-workers](orchestrator-workers.md) |
| v4 — supervised | Actions have real-world consequences | [Human-in-the-loop gates](human-in-the-loop.md), sandboxing, audit log |

## 12. Build checklist

- [ ] Every tool has a JSON Schema with `additionalProperties: false` and required fields declared.
- [ ] Tool descriptions state when **not** to use the tool.
- [ ] Exceptions are converted to actionable text and marked `is_error`.
- [ ] Step, wall-clock, and cumulative-token budgets all exist.
- [ ] Tool output is truncated with an explicit elision marker.
- [ ] The system prompt names the terminal condition.
- [ ] Repeated identical calls are detected and reported back to the model.
- [ ] Every run emits a trace with per-step tokens, latency, tool name, and args.
- [ ] The system prefix is byte-stable across turns (prompt caching).
- [ ] A regression eval set of ≥ 30 tasks runs in CI.

## 13. Related

- [tool-design.md](tool-design.md) — the single highest-leverage change to loop quality
- [context-engineering.md](context-engineering.md) — what to do when history stops fitting
- [prompt-chaining.md](prompt-chaining.md) — the cheaper option when steps are fixed
- [human-in-the-loop.md](human-in-the-loop.md) — gating irreversible actions
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — grading the loop
