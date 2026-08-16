+++
id = "mcp-transports"
title = "MCP transports"
use_when = "Deciding between stdio and Streamable HTTP for shipping a server, or migrating one written before the 2026-07-28 revision"
pack = "MCP servers"
verified_at = 2026-08-12
stale_after = "90d"
+++

# MCP Transports

<!-- verified: 2026-08-12 · current spec revision: 2026-07-28 -->

> How MCP messages get from client to server: a local subprocess over stdio, or a remote service over Streamable HTTP — the latter now stateless, so any request can reach any instance.

**Tier:** intermediate
**Use when:** deciding how to ship a server, or migrating a pre-2026-07-28 server.
**Avoid when:** never — every server picks one. The decision is usually five minutes and then permanent.
**Cost profile:** stdio has near-zero overhead and no auth story. HTTP adds a network hop and requires authorization, but scales horizontally and serves many users.

---

## 1. Problem it solves

A server that runs as a subprocess on the user's machine and a server that serves a thousand users from a cluster have almost nothing in common operationally, but should look identical to the model. Transports are that abstraction.

The 2026-07-28 revision reshaped the remote case. Previously, Streamable HTTP carried a protocol session (`Mcp-Session-Id`) established by an `initialize` handshake, which meant a server instance held per-client state and load balancers needed session affinity. That is gone. **Every request is now self-describing and independently routable.** In exchange, anything that relied on the server initiating contact with the client mid-call had to be redesigned — hence MRTR.

## 2. Shape

```
STDIO (local)                          STREAMABLE HTTP (remote, stateless)

┌──────────┐                           ┌──────────┐
│  client  │                           │  client  │
└────┬─────┘                           └────┬─────┘
     │ spawn subprocess                     │ POST /mcp
     │ JSON-RPC over stdin/stdout           │ headers: Mcp-Method, Mcp-Name,
     │ (one message per line)               │          Authorization
     ▼                                      │ body: {..., _meta: {version, client}}
┌──────────┐                                ▼
│  server  │  stderr = logs            ┌───────────┐
│ process  │  (never protocol data)    │  gateway  │ routes/authorises from HEADERS
└──────────┘                           └─────┬─────┘  (no body parsing needed)
                                    ┌────────┼────────┐
lifetime = client lifetime          ▼        ▼        ▼
one client, one server           inst 1   inst 2   inst 3   ← any instance, no affinity
credentials = the user's         (stateless — nothing shared between requests)

                                 response: JSON, or SSE stream for incremental output
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| stdio framing | One JSON-RPC message per line on stdout | Simple, ordered, no auth | Anything printed to stdout corrupts the stream |
| stderr | Logging only | Never protocol data | Logs written to stdout break the connection |
| HTTP POST endpoint | Receives requests | Single URL, typically `/mcp` | Requiring session affinity |
| Routing headers | `Mcp-Method`, `Mcp-Name` | Gateways route/authorise without parsing bodies | Omitted → gateway must parse JSON |
| `_meta` | Protocol version, client identity, capabilities | Per-request; replaces the handshake | Missing → server cannot negotiate |
| SSE response | Streaming incremental results | Response-scoped, not a persistent channel | Treated as a bidirectional session |
| MRTR | Mid-call input without a held connection | `input_required` + `requestState` | Assuming server-initiated requests still work |
| Tasks extension | Long-running work | `tasks/get` polling, `tasks/update` | Expecting a blocking `tasks/result` |

## 4. Data flow

**stdio:** client spawns the process → writes a JSON-RPC line to stdin → reads a line from stdout → repeat → closes stdin to shut down. Credentials come from the user's environment. No auth layer exists, and none is needed: the process runs as the user.

**Streamable HTTP:**
1. Client POSTs to the endpoint with `Mcp-Method`, `Mcp-Name`, `Authorization`, and `_meta` in the body.
2. Gateway authorises from headers and routes to any instance.
3. Instance handles the request with no prior context.
4. Response is JSON, or SSE if the server streams incremental content for this response.
5. If the server needs input: it returns `input_required` with `inputRequests` and an opaque `requestState`; the client gathers input and **retries the original call** with `inputResponses`.
6. Long-running work returns a task handle; the client polls `tasks/get`.

## 5. Contracts

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Method: tools/call
Mcp-Name: search_orders

{"jsonrpc":"2.0","id":7,"method":"tools/call",
 "params":{"name":"search_orders","arguments":{"status":"shipped"},
           "_meta":{"io.modelcontextprotocol/protocol-version":"2026-07-28",
                    "io.modelcontextprotocol/client":{"name":"host","version":"1.4.0"}}}}
```

```python
from pydantic import BaseModel
from typing import Literal

class TransportChoice(BaseModel):
    kind: Literal["stdio", "http"]
    # stdio
    command: str | None = None
    args: list[str] = []
    # http
    url: str | None = None
    auth: Literal["none", "bearer", "oauth"] = "oauth"
    stateless: bool = True          # required from 2026-07-28
    supports_sse_streaming: bool = True
```

## 6. Reference implementation

stdio — the correct default for local tooling:

```python
import sys, logging
from mcp.server.fastmcp import FastMCP

# CRITICAL: logs go to stderr. A stray print() to stdout corrupts the JSON-RPC stream.
logging.basicConfig(stream=sys.stderr, level=logging.INFO)

mcp = FastMCP("local-tools")

@mcp.tool()
def read_config(path: str) -> str:
    """Read a config file under the configured root."""
    logging.info("read_config %s", path)      # stderr — safe
    return safe_read(path)

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

Streamable HTTP, stateless:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("orders", stateless_http=True)

@mcp.tool()
def start_export(customer_id: str) -> str:
    """Start an order export. Returns a handle to poll with get_export.

    State lives in YOUR datastore keyed by the handle — NOT in server memory.
    Any instance must be able to serve the follow-up call.
    """
    job_id = jobs.create(customer_id)         # durable store, not a dict in RAM
    return f"Export started. Handle: {job_id}. Poll with get_export."

@mcp.tool()
def get_export(job_id: str) -> str:
    """Check an export started by start_export."""
    job = jobs.get(job_id)
    return f"{job.status} — {job.rows} rows" if job else \
           f"No job {job_id!r}. It may have expired; start a new export."

if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8080)
```

Client config for both:

```json
{
  "mcpServers": {
    "local-tools": { "command": "uvx", "args": ["local-tools-mcp@0.4.1"] },
    "orders": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${ORDERS_TOKEN}" }
    }
  }
}
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Transport | stdio local, HTTP remote | Deployment model | Never run stdio across a machine boundary |
| `stateless_http` | true | Horizontal scalability | Required by the current spec; do not disable |
| SSE streaming | on | Perceived latency for long outputs | Off for short, fast tools |
| Request timeout | 30 s | Tail latency | Long work belongs in the Tasks extension, not a long request |
| Handle TTL | 24 h | Follow-up window | Long enough that a user's next turn still works |
| Concurrency per instance | provider-dependent | Throughput | Stateless means you can just add instances |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| stdio connection dies immediately | Something printed to stdout | Run the server manually and watch stdout | All logging to stderr; audit for `print()` |
| Works on one instance, fails on another | In-memory state across calls | Requests failing at random behind a balancer | Move state to a shared store, keyed by an explicit handle |
| Client hangs waiting for a server prompt | Relying on deprecated server-initiated requests | Timeouts on interactive tools | MRTR: return `input_required`, let the client retry |
| Upgrade broke everything | One side expects `initialize`/`Mcp-Session-Id` | Version in `_meta`, connection logs | Migrate both sides together |
| Gateway cannot authorise | `Mcp-Method` / `Mcp-Name` headers missing | Gateway logs parsing bodies | Set both headers on every request |
| Long tool call times out | Work done inline in one request | Latency histogram | Tasks extension with polling |
| Local server cannot reach the network | Sandbox restrictions | Connection errors | Expected — do network work in a remote server |
| Token leaked in logs | `Authorization` logged with the request | Log audit | Redact auth headers |

## 9. Anti-patterns

- **`print()` in a stdio server.** The single most common bug. Stdout is the protocol.
- **In-memory state between HTTP calls.** The spec is stateless; the next request may hit another instance. State goes in a datastore, keyed by a handle you return as data.
- **Session affinity in the load balancer.** You are paying for statelessness and not using it.
- **Long-running work inside one request.** Use the Tasks extension.
- **Legacy HTTP+SSE transport.** Deprecated in 2026-07-28. Migrate.
- **stdio over SSH or a container boundary.** Fragile and unauthenticated. Use HTTP.
- **Skipping `Mcp-Method`/`Mcp-Name` headers.** Forces gateways to parse bodies to route, defeating the design.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Connection failure rate | Failed handshakeless connects | < 0.1% | > 1% |
| Call latency p95 | Request → response | < 1 s | > 3 s |
| Instance-affinity errors | Failures resolved by pinning an instance | 0 | ≥ 1 (state leaked into memory) |
| stdio stream corruption | Parse errors on stdout | 0 | ≥ 1 |
| Task poll count | Polls per long-running task | ≤ 10 | > 30 (poll interval too tight) |
| Auth failure rate | 401/403 | < 1% | > 5% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | stdio, local, user's credentials |
| v1 | Users are not on the machine | Streamable HTTP, stateless, bearer auth |
| v2 | Multiple users / orgs | [OAuth with per-user scoping](mcp-authorization.md) |
| v3 | Load | Multiple instances, no affinity, shared state store |
| v4 | Slow operations | Tasks extension with polling |
| v5 | Public / third-party consumers | Rate limits, quotas, versioned schemas, status page |

## 12. Build checklist

- [ ] stdio servers log exclusively to stderr; no `print()` anywhere.
- [ ] HTTP servers hold no per-client state in memory.
- [ ] Continuity is provided by explicit handles returned as tool output.
- [ ] Handles live in a shared datastore with a TTL.
- [ ] `Mcp-Method` and `Mcp-Name` headers are set on every HTTP request.
- [ ] `_meta` carries the protocol version and client identity per request.
- [ ] Interactive input uses MRTR `input_required` with `requestState`.
- [ ] Long operations use the Tasks extension, not long-held requests.
- [ ] No load-balancer session affinity is required.
- [ ] Legacy HTTP+SSE is not used.
- [ ] Auth headers are redacted in logs.

## 13. Related

- [mcp-protocol-overview.md](mcp-protocol-overview.md) — the protocol and what 2026-07-28 changed
- [mcp-authorization.md](mcp-authorization.md) — securing the HTTP path
- [mcp-server-design.md](mcp-server-design.md) — building the server itself
- [security-and-secrets.md](security-and-secrets.md) — credential handling
