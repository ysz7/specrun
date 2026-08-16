+++
id = "mcp-tool-design"
title = "MCP tool design"
use_when = "Designing the tool surface of an MCP server for consumers you will never meet, running models you did not choose, in contexts you cannot see"
pack = "MCP servers"
verified_at = 2026-08-12
stale_after = "90d"
+++

# MCP Tool Design

<!-- verified: 2026-08-12 · current spec revision: 2026-07-28 -->

> Designing the tool surface of an MCP server for consumers you will never meet, running models you did not choose, in contexts you cannot see.

**Tier:** intermediate
**Use when:** publishing any MCP server.
**Avoid when:** never for a published server. For in-process tools the same rules apply with a shorter feedback loop — see [tool-design.md](tool-design.md).
**Cost profile:** free at runtime. The difference between a server people keep connected and one they disconnect after a week.

---

## 1. Problem it solves

[In-process tool design](tool-design.md) has all the same rules. MCP adds four constraints that change the calculus:

1. **You cannot see the trace.** No debugging the consumer's failing run. The interface must be self-explanatory on first contact.
2. **Your names share a namespace.** A client may connect five servers. Your `search` competes with four other `search` tools.
3. **Your schema is an interface.** Consumers tune agents against it. Changing it silently is a breaking change.
4. **Your output is untrusted input to them.** Anything you return can carry an injection. Format defensively.

The practical consequence: an MCP server has to be **more** disciplined than an internal toolset, not less.

## 2. Shape

```
  ┌───────────── what every connected client pays, every turn ─────────────┐
  │  name (namespaced) · description · input schema                        │
  │  → keep the whole server under ~1 500 tokens of schema                 │
  └────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────── what the model gets back ──────────────────────────┐
  │  bounded (≤ ~2k tokens) · readable · citable ids · observable effects  │
  │  · recovery guidance on empty · retry-or-not on error                  │
  │  · never formatted to look like system instructions                    │
  └────────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Namespaced name | Uniqueness across all connected servers | `orders_search`, not `search` | Generic name collides |
| Description | Selection policy for an unseen model | what · when · **when not** · preconditions | Written for a human reading docs |
| Input schema | Constrain the argument space | Enums, bounds, `additionalProperties: false` | Free strings where enums belong |
| Hard caps | Bound the damage of one call | `min(limit, 50)` server-side | Trusting the client's `limit` |
| Formatter | Readable, bounded output | Tables and ids over nested JSON | Raw upstream payload |
| Error mapper | Retry-or-not + what to change | Text, `isError: true` | HTTP status codes |
| Orientation tool | `list_*` for recovery | Lets a failed search recover | Absent → the model rephrases blindly |
| Schema version | Stability contract | Semver; change = major | Silent drift |

## 4. Data flow

1. Client fetches `tools/list` (cache it with `ttlMs`); schemas enter the model's context.
2. Model selects a tool based **solely** on name + description + schema.
3. Client sends `tools/call`; your server validates and executes.
4. You format the result for a reader with no memory.
5. Model reads it and decides the next step — including whether to retry.

Steps 2 and 4 are the entire quality surface. Everything else is plumbing.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class SearchOrdersInput(BaseModel):
    model_config = {"extra": "forbid"}                 # additionalProperties: false

    customer_email: str | None = Field(
        None, description="Exact match, lowercase. Obtain via orders_get_customer if unknown.")
    status: Literal["pending", "shipped", "delivered", "cancelled"] | None = Field(
        None, description="Order status. Omit for any status.")
    created_after: str | None = Field(
        None, description="ISO-8601 date, e.g. 2026-01-31. Inclusive. UTC.")
    limit: int = Field(20, ge=1, le=50,
                       description="Max rows returned. Default 20, hard maximum 50.")
```

Description template that works for an unseen consumer:

```
<One line: what it does.>
Use when <situation, in the end user's vocabulary>. Returns <shape of the result>.
Do not use for <adjacent case> — use <other_tool> instead.
<Precondition: "Requires an order_id from orders_search.">
```

## 6. Reference implementation

```python
@mcp.tool()
def orders_search(ctx, customer_email: str | None = None,
                  status: str | None = None, created_after: str | None = None,
                  limit: int = 20) -> str:
    """Search orders by customer, status, and date.

    Use when the user asks about order history, refunds, or shipping status.
    Returns a compact table of matching orders plus a total count.
    Do not use to change an order — use orders_update_status.
    Do not use for support conversations — use tickets_search.
    """
    principal = authenticate(ctx.request)
    rows, total = repo.search(tenant_id=principal.tenant_id, email=customer_email,
                              status=status, created_after=created_after,
                              limit=min(limit, 50))          # hard cap, server-side

    if total == 0:
        # Recovery guidance, not just "no results".
        return ("No orders matched these filters. Verify the email with orders_get_customer, "
                "or remove `status` to widen the search. Use orders_list_statuses to see "
                "valid status values.")

    header = "order_id | date | status | total_usd | items"
    body = "\n".join(f"{r.id} | {r.created:%Y-%m-%d} | {r.status:9} | "
                     f"{r.total:>8.2f} | {r.item_summary[:40]}" for r in rows)
    footer = (f"\nShowing {len(rows)} of {total}."
              + (" Narrow with created_after to see the rest." if total > len(rows) else ""))
    return f"{header}\n{body}{footer}"

@mcp.tool()
def orders_list_statuses(ctx) -> str:
    """List valid order status values and what each means.

    Use to orient before searching, or when a search returned nothing and you need to
    know what values exist.
    """
    return "\n".join(f"{s.name:10} — {s.description}" for s in repo.statuses())
```

Error mapping table, applied to every failure path:

```python
ERROR_TEXT = {
    NotFound:    "No {entity} {id!r}. Use {list_tool} to see valid ids.",
    Forbidden:   "This account lacks permission for {action}. Ask the user to grant it. "
                 "Do not retry.",
    Validation:  "{detail} Fix the argument and call again.",
    RateLimited: "Rate limited. Wait {seconds}s. Batch requests instead of looping.",
    Upstream:    "The orders service is unavailable. Retry once in ~10s; if it fails "
                 "again, tell the user and stop.",
}
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Tools per server | ≤ 10 | Selection accuracy across all connected servers | Split servers rather than growing one |
| Name prefix | server name | Collision avoidance | Always prefix |
| Response cap | ~2 000 tokens | Consumer context pressure | Never raise; consumers cannot |
| `limit` hard cap | 50 | Blast radius | Lower for verbose records |
| Default `limit` | 20 | Typical need | Match reality, not capability |
| Identifier format | human-readable | Model can reason about it | `order_2026_00412` over a UUID |
| `ttlMs` on `tools/list` | 300 000 | Client re-fetch rate | Lower only if the surface is dynamic |
| Schema changes | major version | Consumer stability | Always |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Your tool is never called | Name collides, or description uses internal jargon | Call volume vs installs | Prefix names; use end-user vocabulary |
| Wrong tool chosen among your own | Overlapping descriptions | Confusion matrix on a labelled set | Mutual "do not use for" clauses |
| Consumers report context blowups | Unbounded responses | Response token distribution | Hard caps and pagination server-side |
| Model retries after a permission error | Error did not say "do not retry" | Repeated 403s in one session | Explicit retry guidance in every error |
| Search returns nothing, model gives up | No orientation tool | Sessions ending after an empty result | Add `list_*` and reference it in the empty-result text |
| Consumers break after your release | Schema changed in a minor version | Consumer error rate post-release | Semver; deprecate before removing |
| Your output triggers an injection downstream | Content formatted like instructions | Consumer reports | Never emit text resembling system directives; delimit untrusted content |
| Client sends `limit: 10000` | Cap only documented, not enforced | Response sizes | Enforce `min(limit, cap)` server-side |

## 9. Anti-patterns

- **Generic names.** `search`, `get`, `query`, `execute` in a shared namespace. Prefix everything.
- **One tool per API endpoint.** Produces a surface no model can navigate.
- **Documenting a cap without enforcing it.** The model will exceed it.
- **Errors as status codes.** `403` teaches nothing; "ask the user to grant X, do not retry" does.
- **Empty results with no guidance.** The model rephrases blindly and burns turns.
- **Breaking schemas in minor releases.** Consumers tune against your schema.
- **Assuming a specific client or model.** Write for the least-capable consumer you would accept.
- **No orientation tool.** Every search-only server strands agents that guess a wrong query.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Schema context cost | Tokens for all your tools | < 1 500 | > 3 000 |
| Response size p95 | Tokens per result | < 2 000 | > 4 000 |
| Error rate per tool | `isError` / calls | < 3% | > 10% |
| Error recovery rate | Errors followed by a successful call | ≥ 70% | < 40% |
| Empty-result recovery | Empty results followed by a productive call | ≥ 60% | < 30% |
| Per-tool utilisation | Sessions using each tool | ≥ 5% each | < 1% (remove the tool) |
| Argument validation rate | Schema rejections / calls | < 2% | > 5% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | 3–5 task-shaped tools, prefixed names |
| v1 | Consumers misselect | Mutual "do not use for" clauses; enums everywhere |
| v2 | Context complaints | Response caps, pagination, compact formatting |
| v3 | Agents strand on empty results | `list_*` orientation tools, recovery text |
| v4 | Third-party consumers | Published schemas, semver, deprecation windows |
| v5 | Many consumers | Per-tool telemetry driving description rewrites |

## 12. Build checklist

- [ ] Every tool name is prefixed with the server name.
- [ ] Every description has "use when" and "do not use for" naming an alternative.
- [ ] Descriptions use end-user vocabulary, not internal jargon.
- [ ] Every closed-set field is an enum; `additionalProperties: false` everywhere.
- [ ] Every field description states units, format, and where to obtain the value.
- [ ] Caps are enforced server-side, not just documented.
- [ ] Responses are bounded and state what was elided.
- [ ] Mutations return before → after state.
- [ ] Every error says whether to retry and what to change.
- [ ] Empty results include recovery guidance naming a specific tool.
- [ ] At least one `list_*` orientation tool exists.
- [ ] Identifiers are human-readable and stable.
- [ ] Schema changes follow semver with a deprecation window.
- [ ] Output never resembles system instructions.

## 13. Related

- [tool-design.md](tool-design.md) — the underlying principles, with wrong/right code
- [mcp-server-design.md](mcp-server-design.md) — the server around these tools
- [mcp-authorization.md](mcp-authorization.md) — why identity is never an argument
