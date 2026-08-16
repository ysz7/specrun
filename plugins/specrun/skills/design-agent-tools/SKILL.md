---
name: design-agent-tools
description: Designs or repairs the tool interface an agent programs against - names, descriptions, JSON schemas, response formatting, and error messages. Use when an agent picks the wrong tool, ignores a tool, passes bad arguments, blows up its context on tool output, or repeats calls. Also use when adding new tools, converting REST endpoints into agent tools, or reviewing an MCP server's tool surface.
metadata:
  version: "1.0"
  source: AI Engineer Assets
---

# Design Agent Tools

Most "the agent is dumb" reports are tool-interface bugs. Fix the interface before
touching the prompt or the model.

## When this applies

- Agent chooses tool B when tool A was correct
- Agent never calls a tool that clearly applies
- Repeated argument validation errors
- One tool call floods the context
- Agent calls the same tool with the same args repeatedly
- Adding tools, or wrapping an existing API for an agent

## Do not use for

- Building the loop itself → `build-agent-loop`
- Diagnosing a specific failed run → `debug-agent-trajectory`

## Inputs to collect first

| Input | Why needed | Default if unspecified |
|---|---|---|
| Current tool schemas + descriptions | The thing being fixed | Ask for them; do not redesign blind |
| A failing trace, if one exists | Shows the actual confusion | Proceed without, but ask |
| The underlying API/data source | What is actually available | Ask |
| Typical user phrasings | Descriptions must match user vocabulary | Ask for 5 real examples |

## Procedure

### Step 1 — Inventory and cluster

List every tool with its description. Group tools whose descriptions could plausibly
answer the same user request. Every cluster of size > 1 is a selection-accuracy risk.

**Stop condition:** a table of `tool → cluster` exists.

### Step 2 — Reshape around tasks, not endpoints

For each cluster, ask: *what does the agent actually need to accomplish?* If answering one
user question requires 3+ chained calls, collapse them into one task-shaped tool.

```
✗ get_customer → list_orders → get_order → get_shipment      (4 calls, 4 failure points)
✓ search_orders(customer_email, status, created_after)        (1 call)
```

Target: **≤ 15 tools per agent.** Above 20, split by [routing] or sub-agents.

**Stop condition:** no user question requires more than 2 tool calls to answer.

### Step 3 — Rewrite every description to the template

```
<One line: what it does.>
Use when <situation, in the user's vocabulary>. Returns <shape of result>.
Do not use for <adjacent case> — use <other_tool> instead.
<Precondition, if any: "Requires an order_id from search_orders.">
```

The "do not use for" line is what fixes selection errors. Both tools in a confused pair
need one pointing at the other.

**Stop condition:** every description has a "use when" and a "do not use for".

### Step 4 — Tighten the schemas

- Closed set of values → `Literal` / `enum`, never a free string
- `additionalProperties: false` (`model_config = {"extra": "forbid"}` in Pydantic)
- Every field description names units, format, and **where to get the value**
- Defaults on optional fields, and state the default in the description
- Numeric bounds (`ge`, `le`) wherever they exist

**Stop condition:** no field accepts a value the backend would reject.

### Step 5 — Format responses for a reader

- Bound every response (~2 000 tokens). Paginate with an explicit cursor; never silently drop rows.
- Human-readable identifiers (`order_2026_00412`) beat UUIDs — the model can reason about them.
- Compact tabular text beats nested JSON for lists.
- Mutations return the **resulting observable state**, not `{"ok": true}`.
- Empty results say what to try next, not just "no results".

**Stop condition:** every response is under budget and a human could read it without the schema.

### Step 6 — Make errors instructions

Every error string must answer: *should I retry, and what do I change?*

| Class | Bad | Good |
|---|---|---|
| Not found | `404` | `No order 'X'. Use search_orders to find valid ids.` |
| Validation | `ValidationError: created_after` | `created_after must be ISO-8601 (2026-01-31). Reformat and retry.` |
| Permission | `403 Forbidden` | `This account lacks permission. Ask the user to escalate. Do not retry.` |
| Rate limit | `429` | `Rate limited. Wait 30 s. Batch your requests instead of looping.` |

**Stop condition:** no error string is a bare code or a stack trace.

### Step 7 — Measure selection accuracy

Build ≥ 50 labelled `(user request → correct tool)` pairs. Run them, produce a confusion
matrix. Every confused pair gets a "do not use for" clause and, if needed, one few-shot
example in the system prompt.

**Stop condition:** selection accuracy ≥ 95%, and it runs in CI.

## Output contract

- Revised schema file(s) with enums, bounds, and `additionalProperties: false`
- Revised descriptions following the template
- Response formatter per tool with a size bound
- Error-mapping table applied to every failure path
- `evals/tool_selection.jsonl` with ≥ 50 labelled pairs
- A short diff summary: what changed and which failure it addresses

## Verification

- [ ] Confusion matrix shows no pair confused more than twice
- [ ] Arg validation error rate < 2% on the eval set
- [ ] p95 tokens per tool result < 2 000
- [ ] Every mutation's response lets the model verify the effect without another call
- [ ] Calls per successful task dropped vs the baseline
- [ ] Every tool name is unique across all connected servers

## Common mistakes

| Mistake | Why it happens | Correct action |
|---|---|---|
| Mirroring REST endpoints | Backend already exists | Design for the agent's task |
| Returning upstream JSON verbatim | Zero effort | Format and bound it |
| `{"success": true}` | Feels sufficient | Return the resulting state |
| Free strings for closed sets | Faster to write | Enums; they eliminate a whole error class |
| Descriptions in internal jargon | Written by the API owner | Use the user's words |
| Fixing selection errors in the prompt | Prompt is easy to edit | Fix the tool; prompt fixes don't generalise |
| A `misc`/`execute` catch-all | Covers gaps | Delete it; it hides the real missing tool |

## References

- `../blueprints/blueprints/tool-design.md` — full pattern with wrong/right code
- `../blueprints/blueprints/agent-loop.md` — dispatch and truncation
- `../blueprints/blueprints/mcp-tool-design.md` — same rules across a process boundary
