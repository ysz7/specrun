+++
id = "mcp-protocol-overview"
title = "MCP protocol overview"
use_when = "A capability has to be reachable from more than one AI application or owned by another team, and MCP is the candidate; understanding the protocol before building on it"
pack = "MCP servers"
verified_at = 2026-08-12
stale_after = "90d"
+++

# MCP Protocol Overview

<!-- verified: 2026-08-12 · current spec revision: 2026-07-28 -->

> An open JSON-RPC protocol that lets an AI application connect to external tools, data, and prompts through a uniform interface, so a capability written once works in every MCP client.

**Tier:** foundational
**Use when:** a capability needs to be reachable by more than one AI application, owned by a different team, or shipped to third parties.
**Avoid when:** the tool is used by exactly one agent in one codebase. A local function is simpler, faster, and has no protocol surface to secure. MCP earns its cost at a boundary.
**Cost profile:** each connected server's tool schemas occupy context on every turn. Process/network hop per call. The protocol itself is thin.

---

## 1. Problem it solves

Before MCP, every (AI application × external system) pair was bespoke integration code. N applications and M systems meant N×M integrations, each with its own auth, error handling, and schema conventions.

MCP makes it N+M: a system publishes one server; an application implements one client. The USB-C analogy is the official one and it is accurate — the value is the standard connector, not any particular capability.

**The 2026-07-28 revision is a significant break.** The protocol went from a stateful, bidirectional, session-oriented design to a **stateless request/response** one, so any request can hit any server instance behind a load balancer. If you learned MCP before this, several core assumptions no longer hold — see §8 and [mcp-transports.md](mcp-transports.md).

## 2. Shape

```
┌───────────────────────── HOST APPLICATION ──────────────────────────┐
│  (Claude Code / Cowork / IDE / your agent)                          │
│                                                                     │
│   ┌───────────┐   ┌───────────┐   ┌───────────┐                     │
│   │  client   │   │  client   │   │  client   │  one client per     │
│   │     A     │   │     B     │   │     C     │  server connection  │
│   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘                     │
└─────────┼───────────────┼───────────────┼───────────────────────────┘
          │ JSON-RPC 2.0  │               │
     stdio│          HTTP │          HTTP │
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │ local server│ │remote server│ │remote server│
   │ (subprocess)│ │  (stateless)│ │  (stateless)│
   ├─────────────┤ └─────────────┘ └─────────────┘
   │ TOOLS       │  model-invoked actions
   │ RESOURCES   │  application-selected context (files, records)
   │ PROMPTS     │  user-invoked templates (slash commands)
   └─────────────┘
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Host | Runs the model, owns the conversation, enforces policy | Claude Code, Cowork, IDEs, your app | Treating server output as trusted |
| Client | One connection to one server; protocol mechanics | Usually SDK-provided | Reusing a client across servers |
| Server | Exposes tools/resources/prompts | Yours or third-party | Doing too much; exposing an entire API surface |
| **Tools** | Actions the **model** decides to invoke | The primitive that matters most | Endpoint mirroring — see [mcp-tool-design.md](mcp-tool-design.md) |
| **Resources** | Context the **application** selects and attaches | Files, records, URIs; may be templated | Used for things that should be tools |
| **Prompts** | Templates the **user** invokes | Surfaces as slash commands | Rarely implemented; genuinely useful |
| Transport | Message framing | stdio (local), Streamable HTTP (remote) | Legacy HTTP+SSE, now deprecated |

**The three primitives differ by who is in control**, and that is the whole design:
model → tools, application → resources, user → prompts. Getting this wrong is the most common
server design error.

## 4. Data flow (2026-07-28, stateless)

1. No handshake. There is no `initialize`/`initialized` exchange and no `Mcp-Session-Id`.
2. Every request carries protocol version, client identity, and capabilities in `_meta`.
3. HTTP requests carry `Mcp-Method` and `Mcp-Name` headers so gateways can route and authorise without parsing the JSON body.
4. Optional `server/discover` lets a client learn capabilities upfront.
5. `tools/list`, `prompts/list`, `resources/list`, and `resources/read` return `ttlMs` and `cacheScope` hints, so results can be cached like HTTP responses.
6. `tools/call` executes and returns content, or returns `resultType: "input_required"` with `inputRequests` plus an opaque `requestState` — **Multi Round-Trip Requests (MRTR)**. The client gathers the input and retries the original call with `inputResponses` attached. This replaces server-initiated requests that needed a held connection.
7. Long-running work uses the Tasks extension (`io.modelcontextprotocol/tasks`): poll `tasks/get`, supply input via `tasks/update`. Blocking `tasks/result` is gone.

## 5. Contracts

```jsonc
// tools/call request — note _meta carrying what the handshake used to establish
{
  "jsonrpc": "2.0", "id": 7, "method": "tools/call",
  "params": {
    "name": "search_orders",
    "arguments": { "customer_email": "a@b.com", "status": "shipped" },
    "_meta": {
      "io.modelcontextprotocol/protocol-version": "2026-07-28",
      "io.modelcontextprotocol/client": { "name": "example-host", "version": "1.4.0" }
    }
  }
}
```

```jsonc
// tools/call result — content is a list of typed blocks
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "content": [{ "type": "text", "text": "order_2026_00412 | shipped | 129.00" }],
    "isError": false
  }
}
```

```jsonc
// MRTR: server needs something before it can finish
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "resultType": "input_required",
    "inputRequests": [
      { "type": "elicitation",
        "message": "Confirm refund of $129.00 to a@b.com?",
        "schema": { "type": "object",
                    "properties": { "confirm": { "type": "boolean" } },
                    "required": ["confirm"] } }
    ],
    "requestState": "<opaque-blob-the-client-echoes-back>"
  }
}
```

```jsonc
// tools/list with cache hints
{ "result": { "tools": [ /* ... */ ], "ttlMs": 300000, "cacheScope": "public" } }
```

## 6. Reference implementation

Minimal stateless server (Python SDK shape; check your SDK's current API):

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("orders")

@mcp.tool()
def search_orders(customer_email: str | None = None,
                  status: str | None = None,
                  limit: int = 20) -> str:
    """Search orders by customer and status.

    Use when the user asks about order history, refunds, or shipping status.
    Returns a compact table of up to `limit` rows plus a total count.
    Do not use to modify orders — use update_order_status.
    """
    rows, total = repo.search(customer_email, status, min(limit, 50))
    if not rows:
        return ("No orders matched. Verify the email with get_customer, "
                "or remove the status filter to widen the search.")
    body = "\n".join(f"{r.id} | {r.created:%Y-%m-%d} | {r.status:9} | {r.total:>8.2f}"
                     for r in rows)
    return f"order_id | date | status | total_usd\n{body}\n\nShowing {len(rows)} of {total}."

@mcp.resource("orders://{order_id}")
def order_resource(order_id: str) -> str:
    """Full order record. The APPLICATION attaches this; the model does not call it."""
    return repo.get(order_id).to_markdown()

@mcp.prompt()
def refund_review(order_id: str) -> str:
    """User-invoked template: walk through a refund decision."""
    return f"Review order {order_id} for refund eligibility. Check: delivery status, " \
           f"return window, prior refunds. State a recommendation and the rule that drove it."

if __name__ == "__main__":
    mcp.run()          # stdio by default
```

Client-side config (`.mcp.json`):

```json
{
  "mcpServers": {
    "orders": { "command": "uvx", "args": ["orders-mcp@1.4.2"] },
    "internal-docs": {
      "type": "http",
      "url": "https://mcp.example.com/docs",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Transport | stdio local, HTTP remote | Deployment shape | HTTP whenever the server is not on the same machine |
| Tools per server | ≤ 10 | Client-side selection accuracy | Split into focused servers rather than growing one |
| `ttlMs` on list results | 300 000 (5 min) | Client re-fetch rate | Lower if the tool surface changes dynamically |
| `cacheScope` | `private` | Shared-cache safety | `public` only when results are identical for all users |
| Version pinning | pin exactly | Stability | Always pin; schemas are an interface |
| Resources vs tools | by controller | Correct primitive | Model decides → tool; app attaches → resource |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Client and server cannot talk after an upgrade | One side still expects `initialize` / `Mcp-Session-Id` | Version in `_meta`; connection logs | Migrate both sides; see [mcp-transports.md](mcp-transports.md) |
| Server state lost between calls | Protocol sessions were removed in 2026-07-28 | Second call behaves as first | Mint explicit handles and pass them as ordinary tool arguments |
| Server-initiated prompts never arrive | Roots/Sampling/Logging deprecated; no held connection | Feature silently inert | Use MRTR `input_required` instead |
| Model picks the wrong tool | Two servers expose similar names | Tool-selection confusion matrix | Namespace tool names; sharpen descriptions |
| Context bloated before any work | Too many servers connected | Token count of tool schemas | Drop servers used in < 10% of runs |
| Requests fail behind a load balancer | Sticky-session assumptions | 4xx on some instances | Statelessness is the point — remove affinity requirements |
| Third-party server exfiltrates data | It runs with your credentials | Egress monitoring; source review | Read the source; scope tokens; sandbox |
| Tool schema changed under a tuned agent | Unpinned version | Selection accuracy regression | Pin versions; re-run evals on upgrade |

## 9. Anti-patterns

- **Wrapping every REST endpoint as a tool.** The most common MCP mistake. Design task-shaped tools — see [mcp-tool-design.md](mcp-tool-design.md).
- **Assuming stateful sessions.** As of 2026-07-28 they do not exist. If your server needs continuity, issue an explicit handle as data.
- **Using resources for model-invoked actions.** Resources are application-selected. If the model chooses when to fetch it, it is a tool.
- **Connecting servers "in case they're useful".** Every server taxes every turn.
- **Trusting server output.** Tool results are untrusted input. A compromised or hostile server can return instructions.
- **Skipping `prompts`.** They are the cheapest way to give users repeatable workflows, and almost nobody implements them.
- **Unpinned versions.** A minor bump can change a schema and silently degrade an agent.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Tool schema context cost | Tokens for all connected servers | < 3 000 | > 8 000 |
| Tool utilisation | Runs where a server's tool is called | ≥ 10% per server | < 5% (disconnect it) |
| Call latency p95 | Client request → result | < 1 s | > 3 s |
| Error rate per tool | `isError` / calls | < 3% | > 10% |
| List cache hit rate | Cached `tools/list` responses | > 90% | < 50% |
| Version drift | Servers running unpinned | 0 | ≥ 1 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Local functions in one agent. Correct for a single codebase. |
| v1 | A second application needs the capability | stdio MCP server, one focused tool set |
| v2 | Not co-located with the client | Streamable HTTP, stateless, `_meta` protocol version |
| v3 | External or multi-user consumers | [Authorization](mcp-authorization.md), per-user scoping, rate limits |
| v4 | Multiple instances behind a balancer | Statelessness exploited: no affinity, cacheable lists |
| v5 | Long-running operations | Tasks extension with polling |

## 12. Build checklist

- [ ] The capability genuinely crosses a boundary; a local function was ruled out.
- [ ] Primitives chosen by controller: model → tool, app → resource, user → prompt.
- [ ] Protocol version is read from `_meta` on every request, not from a handshake.
- [ ] No reliance on protocol sessions; continuity is an explicit handle in tool args.
- [ ] `Mcp-Method` and `Mcp-Name` headers set on HTTP requests.
- [ ] `ttlMs` and `cacheScope` returned on list endpoints.
- [ ] Interactive confirmations use MRTR `input_required`, not deprecated sampling.
- [ ] Tool names are namespaced to avoid collisions with other servers.
- [ ] Server versions are pinned in client config.
- [ ] Server output is treated as untrusted by the host.
- [ ] Tool count per server ≤ 10.

## 13. Related

- [mcp-transports.md](mcp-transports.md) — stdio vs Streamable HTTP, and what changed
- [mcp-server-design.md](mcp-server-design.md) — how to build one well
- [mcp-tool-design.md](mcp-tool-design.md) — the surface that determines quality
- [mcp-authorization.md](mcp-authorization.md) — OAuth, CIMD, scoping
- [tool-design.md](tool-design.md) — the same rules in-process
