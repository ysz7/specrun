+++
id = "tool-design"
title = "Tool design"
use_when = "An agent has more than one tool and picks the wrong one, sends malformed arguments, or misreads what a tool returned; tool schemas, descriptions and return shapes are being written or reworked"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Tool Design (Agent–Computer Interface)

> The schema, description, and return shape of each tool — the interface the model programs against, designed for a reader that has no memory, no debugger, and one shot per call.

**Tier:** foundational
**Use when:** always, the moment an agent has more than one tool.
**Avoid when:** never. Bad tools cannot be fixed with a better model or a better prompt.
**Cost profile:** zero runtime cost; the highest return-per-hour of any agent work.

---

## 1. Problem it solves

Most "the agent is dumb" reports are tool-interface bugs: two tools whose descriptions overlap, a tool that returns 200 KB of JSON, a tool that returns `{"status":"ok"}` so the model cannot tell whether anything changed. The model is doing correct inference over a bad interface.

You spend real effort on human-computer interfaces. The agent-computer interface deserves the same, and it is measurable.

## 2. Shape

```
        ┌─────────────────────── what the model sees ────────────────────────┐
        │                                                                    │
        │  name          short, verb_noun, unique namespace                  │
        │  description   what it does │ when to use │ when NOT to use        │
        │  input_schema  types, enums, required, additionalProperties:false  │
        │                per-field descriptions with units and format        │
        └────────────────────────────────────────────────────────────────────┘
                                     │ call
                                     ▼
        ┌───────────────────── what the model gets back ─────────────────────┐
        │  natural-language-ish, token-efficient, bounded                    │
        │  + observable effect ("wrote 3 rows; table now has 41")            │
        │  + next-step affordance on error ("use list_tables to see names")  │
        └────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Name | Disambiguate at a glance | `snake_case`, ≤ 64 chars | Generic names (`search`, `get`) collide across servers |
| Description | Selection policy | 2–5 sentences | Describes the API, not the task |
| Input schema | Constrain the arg space | JSON Schema draft 2020-12 | Free-form strings where an enum belongs |
| Handler | Do the work, idempotently where possible | Any | Non-idempotent retry duplicates side effects |
| Response formatter | Compress to signal | Custom | Dumps raw upstream JSON |
| Error mapper | Turn faults into instructions | Custom | Leaks stack traces or returns HTTP codes only |

## 4. Data flow

1. Model reads name + description + schema (costs tokens every turn — keep tight).
2. Model emits args → validator rejects or coerces.
3. Handler executes; side effects happen.
4. Formatter compresses result to ≤ ~2 000 tokens of *signal*.
5. Model reads result and decides the next step.

Steps 1 and 4 are where nearly all quality lives.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class SearchOrdersInput(BaseModel):
    """Search orders. Combine filters; all are ANDed."""
    model_config = {"extra": "forbid"}          # → additionalProperties: false

    customer_email: str | None = Field(
        None, description="Exact match, lowercase. Get it from get_customer if unknown.")
    status: Literal["pending", "shipped", "delivered", "cancelled"] | None = Field(
        None, description="Order status. Omit for any status.")
    created_after: str | None = Field(
        None, description="ISO-8601 date, e.g. 2026-01-31. Inclusive.")
    limit: int = Field(20, ge=1, le=100, description="Max rows. Default 20.")

# Generated schema is what the model sees:
#   SearchOrdersInput.model_json_schema()
```

Description template that works:

```
<One line: what it does.>
Use when <situation>. Returns <shape of result>.
Do not use for <adjacent case> — use <other_tool> instead.
<Any precondition: "Requires a customer_id from get_customer.">
```

## 6. Reference implementation

Same tool, wrong and right.

```python
# ✗ WRONG — endpoint mirror, unbounded dump, opaque errors
def query_db(sql: str) -> str:
    """Run SQL."""
    return json.dumps(conn.execute(sql).fetchall())     # 200 KB, UUIDs, nulls
```

```python
# ✓ RIGHT — task-shaped, bounded, self-describing, actionable errors
def search_orders(customer_email=None, status=None, created_after=None, limit=20) -> str:
    """Search orders by customer, status, and date.

    Use when the user asks about order history, refunds, or shipping status.
    Returns a compact table (up to `limit` rows) plus a total count.
    Do not use to modify orders — use update_order_status.
    """
    rows, total = repo.search(customer_email, status, created_after, limit)

    if total == 0:
        # Tell the model how to recover, don't just say "no results".
        return ("No orders matched. Check the email with get_customer, "
                "or widen the filter by removing `status`.")

    lines = [f"{r.id} | {r.created_at:%Y-%m-%d} | {r.status:9} | {r.total_usd:>8.2f} | {r.item_summary}"
             for r in rows]
    header = "order_id | date | status | total_usd | items"
    footer = (f"\nShowing {len(rows)} of {total}."
              + (f" Narrow with created_after to see the rest." if total > len(rows) else ""))
    return header + "\n" + "\n".join(lines) + footer
```

Error mapping:

```python
ERROR_HINTS = {
    "NotFound":     "No such {entity}. Use list_{entity}s to see valid ids.",
    "Forbidden":    "This account lacks permission. Ask the user to escalate; do not retry.",
    "RateLimited":  "Rate limited. Wait before retrying; batch your requests.",
    "Validation":   "{detail} Fix the argument and call again.",
}
```

The rule: every error tells the model **whether to retry** and **what to change**.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Tools per agent | ≤ 15 | Selection accuracy degrades with count | Split by [routing](routing.md) or sub-agents past ~20 |
| Response budget | 2 000 tokens | Context pressure | Lower with parallel calls; raise for whole-file reads |
| Default `limit` | 20 | Result size | Match to typical need, not max capability |
| Identifier format | human-readable | Model can reason about it | Prefer `order_2026_00412` over a raw UUID |
| Pagination | explicit cursor in response | Model can continue | Never silently drop rows |
| Enum vs free string | enum wherever the set is closed | Kills a whole class of arg errors | Always |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Right intent, wrong tool | Overlapping descriptions | Confusion matrix: intended vs chosen tool on eval set | Add explicit "do not use for X → use Y" to both |
| Repeated arg validation errors | Schema demands knowledge the model lacks | `is_error` by tool + field | Add a discovery tool, or accept a looser type and resolve internally |
| Context blows up after one call | Unbounded response | Tokens per tool result, p95 | Truncate, paginate, summarise; return ids not blobs |
| Model reruns a mutation | Response didn't confirm the effect | Duplicate side effects in logs | Return observable state: "status: pending → shipped" |
| Model never calls a good tool | Description uses internal jargon | Tool-use distribution vs expectations | Rewrite using the user's vocabulary |
| Agent thrashes between two tools | Neither returns enough to decide | Trajectory review | Merge into one task-shaped tool |
| Correct call, wrong interpretation | Ambiguous units or timezone | Manual trace read | Put units in the field description **and** in the response |

## 9. Anti-patterns

- **One tool per REST endpoint.** Design for the agent's *task*, not your service topology. `search_orders` beats `get_customer` + `list_orders` + `get_order` + `get_shipment`, which forces four round-trips and four chances to fail.
- **Returning raw upstream JSON.** UUIDs, nulls, and internal enums burn tokens and carry no signal. Format for a reader.
- **`{"success": true}`.** The model cannot verify anything. Return the resulting state.
- **A `misc`/`execute` catch-all tool.** It absorbs every ambiguous call and hides the real gap in your toolset.
- **Optional arguments with no default documented.** The model guesses.
- **Undocumented preconditions.** If `update_order` needs an id from `search_orders`, say so in the description.
- **Tuning the prompt to work around a bad tool.** Fix the tool; the prompt fix will not generalise.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Tool selection accuracy | Correct tool chosen on labelled eval set | ≥ 95% | < 90% |
| Arg validation error rate | Schema rejections / calls | < 2% | > 5% |
| Tokens per tool result | p50 / p95 | p95 < 2 000 | p95 > 5 000 |
| Calls per successful task | p50 | ≤ 4 | > 8 |
| Redundant call rate | Identical `(name, args)` repeats | < 1% | > 5% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | 3–5 hand-written tools, plain descriptions |
| v1 | Selection errors appear | Enums, `additionalProperties:false`, "do not use for" clauses |
| v2 | Context pressure | Response formatting, pagination, truncation contracts |
| v3 | > 15 tools | Namespacing, sub-agents with disjoint toolsets, [routing](routing.md) |
| v4 | Multi-team ownership | Tools behind [MCP servers](mcp-tool-design.md) with versioned schemas |

## 12. Build checklist

- [ ] Every description contains a "use when" and a "do not use for".
- [ ] Every closed-set field is an enum, not a string.
- [ ] `additionalProperties: false` on every schema.
- [ ] Every field description states units, format, and where to obtain the value.
- [ ] Every response is bounded and states what was elided.
- [ ] Mutations return the resulting observable state.
- [ ] Every error string says whether to retry and what to change.
- [ ] Identifiers are human-readable and stable.
- [ ] Tool names are unique across all connected servers (namespace them).
- [ ] A labelled eval set measures tool-selection accuracy in CI.

## 13. Related

- [agent-loop.md](agent-loop.md) — where tools are dispatched
- [context-engineering.md](context-engineering.md) — budgeting the tokens tools consume
- [mcp-tool-design.md](mcp-tool-design.md) — the same rules across a process boundary
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — measuring selection accuracy
