---
name: build-agent-loop
description: Builds a production-shaped agent tool-use loop with step budgets, tool dispatch, error handling, truncation, loop detection, and tracing. Use when the user asks to build an AI agent, create an agent from scratch, set up a tool-use loop, add tool calling to an LLM, make a model that can use tools, or scaffold an agentic backend. Also use when an existing agent needs governance added - step caps, cost limits, or structured traces.
metadata:
  version: "1.0"
  source: AI Engineer Assets
---

# Build an Agent Loop

## When this applies

- "Build me an agent that can <do something with tools>"
- An LLM integration exists but has no tool-calling loop
- An existing loop has no budgets, no truncation, or no traces

## Do not use for

- Fixed, known step sequences → build a chain instead (see `../blueprints/blueprints/prompt-chaining.md`)
- Adding *one* tool to an existing working loop → use `design-agent-tools`
- Diagnosing why an existing agent failed → use `debug-agent-trajectory`

## Inputs to collect first

| Input | Why needed | Default if unspecified |
|---|---|---|
| Task the agent performs | Determines tools and stop condition | Ask — do not guess |
| Language / framework | Code shape | Python + the provider's official SDK |
| Available tools or APIs | The toolset | Start with 3; add only what the task needs |
| Any irreversible actions? | Decides whether gating is required | Assume yes if anything writes outside a sandbox |
| Latency / cost ceiling | Sets `max_steps` and model tier | 20 steps, 300 s, frontier model |

If running unattended, take the defaults and state them at the top of the output.

## Procedure

### Step 1 — Write the stop condition before anything else

State, in one sentence, what "done" looks like. Put it verbatim in the system prompt.
An agent without an explicit terminal condition runs until the step cap.

> "You are done when you have <X>. Reply with plain text and no tool call."

**Stop condition:** the sentence exists and is unambiguous to a reader with no context.

### Step 2 — Define 3–5 tools, task-shaped

Not one per API endpoint. One per thing the agent actually needs to do. For each:

- `name`: `snake_case`, verb_noun, unique
- `description`: what it does · when to use it · **when not to** (naming the alternative)
- schema: enums for closed sets, `additionalProperties: false`, units in every field description

Read `../blueprints/blueprints/tool-design.md` §6 before writing the first one.

**Stop condition:** a reader can pick the right tool from descriptions alone, with no other context.

### Step 3 — Implement the loop

Copy the reference implementation from `../blueprints/blueprints/agent-loop.md` §6. It must have,
non-negotiably:

- [ ] step counter capped at `max_steps`
- [ ] wall-clock deadline
- [ ] `try/except` per tool converting exceptions to actionable text with `is_error: true`
- [ ] tool-output truncation with an explicit elision marker
- [ ] one `tool_result` per `tool_use`, same order, matching IDs
- [ ] parallel execution only when tools do not share mutable state

**Stop condition:** the loop terminates on a task designed to be impossible, and returns a message saying so.

### Step 4 — Add loop detection

Hash `(tool_name, sorted_args)` per call. On a repeat, return the repeat as an error:

```python
if h in seen:
    return {"content": f"You already called {name} with these exact arguments and got: "
                       f"{seen[h][:300]}. That did not work. Try a different approach.",
            "is_error": True}
```

**Stop condition:** an agent given a tool that always returns the same unhelpful answer stops within 3 calls instead of looping to the cap.

### Step 5 — Gate irreversible actions

If any tool sends email, moves money, deletes data, or writes outside a sandbox, implement the
policy table from `../blueprints/blueprints/human-in-the-loop.md` §6 before shipping. Policy in code,
never in the prompt. Unknown tools default to gated.

**Stop condition:** every registered tool has a policy entry; startup asserts this.

### Step 6 — Emit a trace per run

One structured record per step: step index, tool name, args, latency, input/output tokens,
`is_error`, and the final outcome. Without this you cannot debug or evaluate anything.

**Stop condition:** a failed run can be fully reconstructed from the trace alone.

### Step 7 — Build a 20–30 task eval set

Real tasks with checkable outcomes. Include: 2 that need no tools, 2 that need 5+ steps,
2 where a tool errors, 2 that are impossible (the agent should say so).

**Stop condition:** the suite runs in CI and reports success rate, steps p95, and cost p95.

## Output contract

```
agent/
├── loop.py            # the loop, budgets, dispatch, truncation, loop detection
├── tools/
│   ├── __init__.py    # registry: name → (schema, handler)
│   └── <tool>.py      # one file per tool
├── prompts/
│   └── system.md      # includes the verbatim stop condition
├── policy.py          # action policy table (if any tool is irreversible)
├── trace.py           # structured per-step trace emission
└── evals/
    └── tasks.jsonl    # 20-30 tasks with expected outcomes
```

## Verification

- [ ] Impossible task → agent says it cannot do it, does not hit the step cap
- [ ] Tool that raises → error text reaches the model, agent adapts
- [ ] Tool returning 500 KB → truncated with an elision marker, context survives
- [ ] Same call twice → loop detection fires
- [ ] Irreversible tool → gate blocks it and the refusal returns as a tool result
- [ ] Eval suite green with success rate ≥ 80%
- [ ] System prefix byte-identical across turns (check cache hit rate > 50%)

## Common mistakes

| Mistake | Why it happens | Correct action |
|---|---|---|
| Exceptions crash the loop | Standard error handling instincts | Convert to a tool result the model can act on |
| No step cap | "The model knows when to stop" | It does not. Always cap. |
| Tool per API endpoint | Mirroring the backend | Design around agent tasks |
| Tool returns raw JSON | Easiest to write | Format for a reader; bound the size |
| Timestamp in the system prompt | Seems harmless | Kills prompt caching; put it in a tool result |
| Mismatched tool_use/tool_result IDs | Manual message assembly | Build results from the call blocks directly |

## References

- `../blueprints/blueprints/agent-loop.md` — full pattern, failure modes, metrics
- `../blueprints/blueprints/tool-design.md` — tool interface rules
- `../blueprints/blueprints/human-in-the-loop.md` — the policy table
- `../blueprints/blueprints/context-engineering.md` — when history stops fitting
