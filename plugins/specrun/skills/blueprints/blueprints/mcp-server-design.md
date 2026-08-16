+++
id = "mcp-server-design"
title = "MCP server design"
use_when = "Building an MCP server someone else will use: what it exposes, which primitive each capability should be, state and errors across a stateless boundary, versioning"
pack = "MCP servers"
verified_at = 2026-08-12
stale_after = "90d"
+++

# MCP Server Design

<!-- verified: 2026-08-12 · current spec revision: 2026-07-28 -->

> Deciding what a server exposes, which primitive each capability should be, how state and errors are handled across a stateless boundary, and how it is versioned and shipped.

**Tier:** intermediate
**Use when:** building an MCP server anyone other than you will use.
**Avoid when:** the capability is used by one agent in one repo — a local function is simpler and faster.
**Cost profile:** the design costs a day and pays back for years. Redesigning a published server's tool surface breaks every consumer.

---

## 1. Problem it solves

The tempting design is "wrap our API". It produces servers with 40 tools, overlapping names, unbounded JSON responses, and HTTP status codes as error messages. Every client that connects gets worse at everything, because tool schemas cost context on every turn and selection accuracy falls with tool count.

A good server is small, task-shaped, and self-describing. The discipline: **your server is a UI for a reader with no memory, no documentation, and one attempt per call.**

The second design pressure is statelessness. Since 2026-07-28 there is no protocol session, so continuity must be modelled explicitly as data.

## 2. Shape

```
   ┌──────────────────────── SERVER ─────────────────────────┐
   │                                                         │
   │  TOOLS (model-invoked)          ≤ 10, task-shaped       │
   │    search_orders  update_status  start_export           │
   │                                                         │
   │  RESOURCES (app-attached)       orders://{id}           │
   │    stable URIs, templated, cacheable                    │
   │                                                         │
   │  PROMPTS (user-invoked)         /refund-review          │
   │    slash commands with arguments                        │
   │                                                         │
   ├─────────────────────────────────────────────────────────┤
   │  handle store  │  auth/scoping  │  formatter │ errors    │
   │  (durable,     │  (per-request  │  (bounded, │ (actionable│
   │   TTL'd)       │   token → id)  │   readable)│  text)    │
   └─────────────────────────────────────────────────────────┘
              │                              │
        no in-memory state          every response ≤ ~2k tokens
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Tool set | The model-facing capabilities | ≤ 10, task-shaped | Endpoint mirroring |
| Resource set | Application-attachable context | Stable URI scheme | Used where a tool belongs |
| Prompt set | User-invoked workflows | Surfaces as slash commands | Never implemented |
| Handle store | Cross-call continuity | Durable, TTL'd, keyed | Kept in process memory |
| Scoping layer | Token → tenant/user | Derived from auth, never from arguments | Trusting a `tenant_id` argument |
| Formatter | Bound and shape responses | Readable text over raw JSON | Dumping upstream payloads |
| Error mapper | Faults → instructions | Says retry-or-not and what to change | Returning status codes |
| Version policy | Schema stability | Semver; schema changes are major | Silent schema drift |

## 4. Data flow

1. Request arrives with `_meta` (protocol version, client identity) and an auth token.
2. Auth layer resolves the token to a principal and derives the tenant/user scope. **Never from tool arguments.**
3. Arguments are validated against the JSON Schema; failures return an instruction, not a stack trace.
4. Handler executes, using the handle store for any continuity.
5. If human input is required mid-call: return `input_required` with `inputRequests` and an opaque `requestState`; the client retries with `inputResponses`.
6. If the work is long: create a task, return the handle, let the client poll `tasks/get`.
7. Formatter bounds the response and shapes it for a reader.
8. Errors map to actionable text with `isError: true`.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class ServerManifest(BaseModel):
    """Write this before writing code. If it does not fit on a page, the server is too big."""
    name: str
    purpose: str = Field(max_length=200, description="One sentence: what domain, for whom.")
    tools: list[str] = Field(max_length=10)
    resources: list[str] = Field(description="URI templates, e.g. 'orders://{order_id}'")
    prompts: list[str]
    scoping: Literal["per_user", "per_tenant", "global"]
    state_model: Literal["stateless", "handle_based"]

class Handle(BaseModel):
    """Continuity across a stateless boundary. This is data, not a session."""
    id: str
    kind: str
    tenant_id: str
    payload: dict
    created_at: float
    expires_at: float
```

## 6. Reference implementation

```python
from mcp.server.fastmcp import FastMCP, Context

mcp = FastMCP("orders", stateless_http=True)

def scope(ctx: Context) -> str:
    """Tenant comes from the TOKEN. A tool argument is model-controlled and therefore
    attacker-controlled via prompt injection."""
    principal = auth.resolve(ctx.request.headers["Authorization"])
    return principal.tenant_id

# ---------- TOOL: model decides when ----------
@mcp.tool()
def search_orders(ctx: Context, customer_email: str | None = None,
                  status: str | None = None, limit: int = 20) -> str:
    """Search orders by customer and status.

    Use when the user asks about order history, refunds, or shipping status.
    Returns a compact table of up to `limit` rows plus a total count.
    Do not use to change an order — use update_order_status.
    """
    rows, total = repo.search(tenant_id=scope(ctx), email=customer_email,
                              status=status, limit=min(limit, 50))   # hard cap
    if not rows:
        return ("No orders matched. Verify the email with get_customer, or drop the "
                "status filter to widen the search.")
    body = "\n".join(f"{r.id} | {r.created:%Y-%m-%d} | {r.status:9} | {r.total:>8.2f}"
                     for r in rows)
    more = f" Narrow by created_after to see the rest." if total > len(rows) else ""
    return f"order_id | date | status | total_usd\n{body}\n\nShowing {len(rows)} of {total}.{more}"

# ---------- TOOL: mutation returns observable state ----------
@mcp.tool()
def update_order_status(ctx: Context, order_id: str,
                        new_status: Literal["pending", "shipped", "cancelled"]) -> str:
    """Change an order's status. Requires an order_id from search_orders."""
    try:
        before, after = repo.update_status(scope(ctx), order_id, new_status)
    except NotFound:
        return f"No order {order_id!r}. Use search_orders to find valid ids."
    except Forbidden:
        return ("This account cannot change order status. Ask the user to escalate. "
                "Do not retry.")
    # The model must be able to verify the effect without another call.
    return f"Order {order_id}: status {before} → {after}."

# ---------- TOOL: long work becomes a handle ----------
@mcp.tool()
def start_export(ctx: Context, created_after: str) -> str:
    """Start a CSV export of orders. Returns a handle; poll with get_export."""
    job_id = jobs.create(scope(ctx), created_after)   # durable store, survives instance loss
    return f"Export started. Handle: {job_id}. Poll with get_export(job_id)."

# ---------- RESOURCE: application attaches it ----------
@mcp.resource("orders://{order_id}")
def order_record(order_id: str) -> str:
    """Full order record as markdown. The host attaches this; the model does not call it."""
    return repo.get(order_id).to_markdown()

# ---------- PROMPT: user invokes it ----------
@mcp.prompt()
def refund_review(order_id: str) -> str:
    """Walk through a refund decision for an order."""
    return (f"Review order {order_id} for refund eligibility.\n"
            f"Check in order: delivery status, return window, prior refunds on this account.\n"
            f"State a recommendation and name the specific rule that drove it.")
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Tools per server | ≤ 10 | Client selection accuracy | Split into focused servers rather than growing |
| Response cap | ~2 000 tokens | Client context pressure | Never raise without measuring the client's occupancy |
| `limit` hard cap | 50 | Blast radius of one call | Lower for verbose records |
| Handle TTL | 24 h | Follow-up window | Long enough for the user's next session |
| `ttlMs` on lists | 300 000 | Client re-fetch rate | Lower only if the tool surface is dynamic |
| Version policy | semver, schema change = major | Consumer stability | Always |
| Scoping | per_tenant from token | Isolation | Never derive from arguments |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Clients pick the wrong tool | Overlapping descriptions | Selection confusion matrix across clients | "Do not use for X — use Y" in both descriptions |
| One call floods client context | Unbounded response | Response token distribution | Hard caps, pagination, compact formatting |
| Tenant leakage | `tenant_id` accepted as an argument | Two-tenant test | Derive scope from the token only |
| Works locally, fails at scale | State in process memory | Random failures behind a balancer | Handle store in a shared datastore |
| Model retries a mutation | Response did not confirm the effect | Duplicate writes in logs | Return before → after state |
| Consumers break on upgrade | Schema changed in a minor release | Consumer error rate after release | Semver discipline; schema change = major |
| Model cannot recover from an error | Errors are status codes | `isError` rate without recovery | Errors say retry-or-not and what to change |
| Prompt injection triggers a write | Server trusts model-supplied scope | Audit of writes vs principals | Scope from auth; gate writes host-side |

## 9. Anti-patterns

- **One tool per API endpoint.** Produces 40 tools nobody can select between.
- **Accepting `tenant_id` / `user_id` as tool arguments.** Model-controlled, therefore injection-controlled. Derive from the token.
- **Returning raw upstream JSON.** UUIDs, nulls, internal enums — all token cost, no signal.
- **`{"success": true}` on mutations.** The model cannot verify anything and will re-call.
- **State in a module-level dict.** Fine on one instance, broken on three.
- **Skipping resources and prompts.** Then everything becomes a tool, including things the app or user should control.
- **Breaking schemas in minor releases.** Consumers tune agents against your schema; it is an interface.
- **No `list_*` orientation tool.** Agents that search and find nothing have no way to discover what exists.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Tools exposed | Count | ≤ 10 | > 15 |
| Schema context cost | Tokens for all schemas | < 1 500 | > 3 000 |
| Response size p95 | Tokens per result | < 2 000 | > 4 000 |
| Error rate per tool | `isError` / calls | < 3% | > 10% |
| Error recovery rate | Errors followed by a successful retry | ≥ 70% | < 40% |
| Tool utilisation | Tools called in ≥ 5% of sessions | 100% of tools | any tool < 1% (remove it) |
| Cross-tenant leakage | Foreign records returned | 0 | ≥ 1 (incident) |
| Latency p95 | Per tool | < 1 s | > 3 s |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Local functions |
| v1 | A second consumer | stdio server, 3–5 task-shaped tools |
| v2 | Remote consumers | Stateless HTTP, handle-based continuity |
| v3 | Multi-tenant | Token-derived scoping, per-tenant rate limits |
| v4 | Third-party consumers | Semver, published schemas, deprecation policy, status page |
| v5 | Slow operations | Tasks extension with polling |

## 12. Build checklist

- [ ] A one-page manifest exists before any code.
- [ ] ≤ 10 tools, each task-shaped, each with "use when" and "do not use for".
- [ ] Primitive chosen by controller: model → tool, app → resource, user → prompt.
- [ ] Scope derived from the auth token; no identity arguments accepted.
- [ ] Hard caps on `limit` and response size, regardless of what is requested.
- [ ] Mutations return before → after state.
- [ ] Errors state whether to retry and what to change.
- [ ] Empty results include a recovery suggestion.
- [ ] A `list_*` orientation tool exists.
- [ ] No process-local state; continuity via TTL'd handles in a shared store.
- [ ] Long operations use the Tasks extension.
- [ ] Semver with schema changes as major; a deprecation policy is published.
- [ ] Two-tenant isolation test in CI.

## 13. Related

- [mcp-tool-design.md](mcp-tool-design.md) — the tool surface in detail
- [mcp-transports.md](mcp-transports.md) — stdio vs stateless HTTP
- [mcp-authorization.md](mcp-authorization.md) — deriving scope safely
- [tool-design.md](tool-design.md) — the in-process equivalent
