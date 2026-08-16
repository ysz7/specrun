+++
id = "a2a-agent-to-agent"
title = "Agent-to-agent (A2A)"
use_when = "Handing an outcome to an autonomous agent you do not own — another team's or another company's — by specifying the goal rather than the call"
pack = "agent protocols"
verified_at = 2026-08-12
stale_after = "90d"
+++

# A2A — Agent-to-Agent Protocol

<!-- verified: 2026-08-12 · A2A v1.0, Linux Foundation -->

> Handing an *outcome* to another autonomous agent — one you do not own, possibly in another
> organisation — and tracking it as a long-running task with its own lifecycle.

**Tier:** advanced
**Use when:** another team's or company's agent owns a step; you want to specify the goal, not
the arguments; the two sides have separate auth domains.
**Avoid when:** the other side is a tool you can call precisely (use MCP), or a specialist in your
own process (use a sub-agent). A2A across an in-process boundary is pure overhead.
**Cost profile:** a network hop plus task lifecycle management. Justified by organisational
boundaries, not by technical ones.

---

## 1. Problem it solves

MCP answers "give me this capability with these exact arguments". It breaks down when you do not
know the arguments — when what you want is *"review this contract for compliance risk"* and the
other side's agent decides how.

A2A is built for that: opaque agents exchanging **tasks**, with discovery, a task lifecycle,
streaming updates, and an auth model that assumes the two parties are in different trust domains.

The deliberate design choice is **opacity**: you do not see the remote agent's tools, prompts, or
internal state. You see an Agent Card describing what it can do, and a task with a status. That
is what makes cross-organisation delegation possible at all.

## 2. Shape

```
   YOUR AGENT                                        REMOTE AGENT
      │
      │ 1. GET /.well-known/agent-card.json
      │───────────────────────────────────────────────────▶
      │◀── Agent Card: name, skills[], securitySchemes[],
      │    supportedInterfaces[], capabilities, signatures[]
      │
      │ 2. verify signature (JWS over canonicalised card)
      │    obtain credentials per securitySchemes
      │
      │ 3. SendMessage / SendStreamingMessage
      │    { role: ROLE_USER, parts: [text | data | url | raw] }
      │───────────────────────────────────────────────────▶
      │◀── Task { id, status: TASK_STATE_SUBMITTED }
      │
      │ 4. SubscribeToTask  (SSE)  or  push notification webhook
      │◀── statusUpdate: WORKING
      │◀── artifactUpdate: partial deliverable
      │◀── statusUpdate: INPUT_REQUIRED  ─── needs something from you
      │ ── SendMessage (same task) with the answer ───────▶
      │◀── statusUpdate: COMPLETED  + artifacts[]
      │    (stream closes on any terminal state)
```

## 3. Components

| Component | Responsibility | Detail | Primary failure mode |
|---|---|---|---|
| Agent Card | Discovery manifest | `/.well-known/agent-card.json` (RFC 8615) | Consumed without verifying its signature |
| `skills[]` | Advertised capabilities | id, name, description, tags, examples, input/output modes | Vague descriptions — you cannot tell what it does |
| `securitySchemes` | How to authenticate | OAuth2, OIDC, API key, mTLS, in OpenAPI 3 form | Credentials placed in the payload instead of headers |
| `signatures[]` | Tamper evidence | JWS (RFC 7515) over the canonicalised card (RFC 8785) | Not verified, so the card is attacker-controllable |
| `supportedInterfaces[]` | Protocol bindings | JSON-RPC 2.0/HTTPS, gRPC, HTTP+JSON/REST | Assuming one binding is available |
| Task | The unit of work | Has an id, a lifecycle, history, artifacts | Treated as a request/response call |
| Message / Part | What is exchanged | Part is exactly one of `text`, `data`, `url`, `raw` | Stuffing structured data into `text` |
| Artifact | The deliverable | `artifactId`, `name`, `parts[]` | Confused with a message |
| Push notification config | Webhook for long tasks | Signed JWT, HMAC, or mTLS auth | Unauthenticated webhook endpoint |

**Task lifecycle states (v1.0):**

| State | Category | Meaning |
|---|---|---|
| `TASK_STATE_SUBMITTED` | in-flight | Accepted, not started |
| `TASK_STATE_WORKING` | in-flight | Active |
| `TASK_STATE_INPUT_REQUIRED` | interrupted | Needs something from you |
| `TASK_STATE_AUTH_REQUIRED` | interrupted | Needs additional credentials |
| `TASK_STATE_COMPLETED` | terminal | Success |
| `TASK_STATE_FAILED` | terminal | Unrecoverable error |
| `TASK_STATE_CANCELED` | terminal | Cancelled before completion |
| `TASK_STATE_REJECTED` | terminal | Refused — policy, quota, or capability |

`REJECTED` is not `FAILED`. It means the remote agent declined; retrying identically will decline
again. Handle them differently.

## 4. Data flow

1. **Discover.** Fetch the Agent Card. **Verify its signature** against the issuer's public key
   before trusting anything in it, including the credentials it asks for.
2. **Authenticate** per `securitySchemes`. Credentials go in HTTP headers, never in the payload.
3. **Submit** with `SendMessage` (returns immediately) or `SendStreamingMessage` (submits and
   streams in one call).
4. **Track.** Subscribe over SSE, or register a push-notification webhook for tasks that outlive
   a connection. Stream event types are discriminated by JSON member: `task`, `statusUpdate`,
   `artifactUpdate`, `message`.
5. **Handle interruptions.** `INPUT_REQUIRED` and `AUTH_REQUIRED` are normal states, not errors.
   Reply on the same task.
6. **Terminal state** closes the stream. Collect artifacts. Handle `REJECTED` distinctly from
   `FAILED`.
7. **Propagate trace context** — `traceparent` / `tracestate` — so a cross-agent run is one trace.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal, Any

TaskState = Literal[
    "TASK_STATE_SUBMITTED", "TASK_STATE_WORKING",
    "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED",
    "TASK_STATE_COMPLETED", "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED", "TASK_STATE_REJECTED",
]

class Part(BaseModel):
    """Exactly one of these is set."""
    text: str | None = None
    data: dict[str, Any] | None = None
    url: str | None = None
    raw: bytes | None = None
    mediaType: str | None = None
    filename: str | None = None

class Message(BaseModel):
    role: Literal["ROLE_USER", "ROLE_AGENT"]
    parts: list[Part]

class Artifact(BaseModel):
    artifactId: str
    name: str
    parts: list[Part]

class RemoteAgent(BaseModel):
    """What you record locally about a peer. Treat as untrusted until verified."""
    card_url: str
    signature_verified: bool = Field(description="Must be True before any task is submitted.")
    skills: list[str]
    binding: Literal["jsonrpc", "grpc", "rest"]
    auth_scheme: str
    supports_streaming: bool
    supports_push: bool
```

## 6. Reference implementation

```python
import httpx, json

WELL_KNOWN = "/.well-known/agent-card.json"

async def discover(base_url: str) -> RemoteAgent:
    async with httpx.AsyncClient(timeout=10) as c:
        card = (await c.get(base_url.rstrip("/") + WELL_KNOWN)).json()

    # The card is an UNTRUSTED document that tells you which credentials to send.
    # Verify before acting on it.
    if not verify_jws(card, issuer_public_key_for(base_url)):
        raise SecurityError(f"Agent Card signature invalid for {base_url}")

    iface = pick_interface(card["supportedInterfaces"])   # prefer what you already speak
    return RemoteAgent(
        card_url=base_url + WELL_KNOWN, signature_verified=True,
        skills=[s["id"] for s in card.get("skills", [])],
        binding=iface["binding"], auth_scheme=first_scheme(card["securitySchemes"]),
        supports_streaming=card["capabilities"].get("streaming", False),
        supports_push=card["capabilities"].get("pushNotifications", False),
    )


async def delegate(agent: RemoteAgent, goal: str, context: dict, creds) -> dict:
    """Submit a task and follow it to a terminal state."""
    if not agent.signature_verified:
        raise SecurityError("Refusing to submit a task to an unverified agent")

    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "SendStreamingMessage",
        "params": {"message": {"role": "ROLE_USER", "parts": [
            {"text": goal},
            {"data": context},          # structured context as `data`, not stuffed into text
        ]}},
    }
    headers = {**creds.as_headers(),                       # credentials in HEADERS, never payload
               "traceparent": current_traceparent(),        # one trace across both agents
               "Accept": "text/event-stream"}

    artifacts, task_id, state = [], None, None
    async with httpx.AsyncClient(timeout=None) as c:
        async with c.stream("POST", agent.endpoint, json=payload, headers=headers) as r:
            async for line in r.aiter_lines():
                if not line.startswith("data: "):
                    continue
                ev = json.loads(line[6:])
                if "task" in ev:
                    task_id, state = ev["task"]["id"], ev["task"]["status"]
                elif "statusUpdate" in ev:
                    state = ev["statusUpdate"]["state"]
                    if state == "TASK_STATE_INPUT_REQUIRED":
                        # A normal state, not an error. Answer on the SAME task.
                        await answer_input_request(agent, task_id, ev["statusUpdate"], creds)
                    elif state == "TASK_STATE_AUTH_REQUIRED":
                        creds = await escalate_credentials(agent, ev["statusUpdate"])
                elif "artifactUpdate" in ev:
                    artifacts.append(ev["artifactUpdate"])

    if state == "TASK_STATE_REJECTED":
        # Declined, not failed. Retrying the same request will be declined again.
        raise RemoteRejected(f"{agent.card_url} rejected the task; do not retry identically")
    if state == "TASK_STATE_FAILED":
        raise RemoteFailed(f"{agent.card_url} failed the task")
    return {"task_id": task_id, "artifacts": artifacts}
```

For tasks measured in minutes or hours, register a push-notification config instead of holding a
stream — the same reasoning as jobs versus streaming in an HTTP API.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Binding | JSON-RPC 2.0/HTTPS | Interop breadth | gRPC for internal high-volume paths |
| Tracking | SSE under ~2 min; push webhooks above | Reliability | Long tasks must not depend on a held connection |
| Signature verification | required | Security | Never optional |
| Credential scope | per-skill scopes from `security[]` | Blast radius | Request the narrowest scope the skill needs |
| Timeout per task | task-specific | Hung remote agents | Always set one; cancel on expiry |
| Retry on `REJECTED` | never identically | Wasted calls | Change the request or escalate to a human |
| Trace propagation | on | Cross-agent debugging | Always — otherwise the trace stops at the boundary |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Sent credentials to an attacker | Agent Card not signature-verified | Card served from a compromised host | Verify JWS before acting on the card |
| Task hangs forever | `INPUT_REQUIRED` treated as an error and ignored | Tasks stuck in an interrupted state | Handle interrupted states explicitly |
| Repeated identical rejections | `REJECTED` retried like `FAILED` | Same task rejected N times | Distinguish the two; escalate rejections |
| Lost updates on long tasks | Held SSE connection dropped | Tasks with no terminal state recorded | Push notifications for long-running work |
| Cannot debug a cross-agent failure | Trace context not propagated | Trace ends at the boundary | Send `traceparent` / `tracestate` |
| Remote agent over-privileged | Broad scopes requested and granted | Audit of granted scopes | Per-skill scopes from `security[]` |
| Structured context mangled | Data serialised into a `text` part | Remote misinterprets input | Use `data` parts for structured input |
| Used A2A for an in-process specialist | Protocol for a function call | Latency with no isolation gain | Sub-agent instead |

## 9. Anti-patterns

- **Trusting an unsigned or unverified Agent Card.** It is a document that tells you which
  credentials to send. Verify it first.
- **Treating a task as a request/response call.** It has a lifecycle with interrupted states; code
  that ignores them hangs.
- **Retrying `REJECTED` identically.** The remote agent declined on policy, quota, or capability.
  Nothing changes on retry.
- **Holding an SSE stream for a 40-minute task.** Use push notifications.
- **Credentials in the payload.** They belong in headers.
- **A2A between components you own in one process.** Use a sub-agent; you get isolation without a
  protocol.
- **Not propagating trace context.** Cross-agent failures become unattributable.
- **Granting one broad credential for all skills.** Scope per skill, as the card declares.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Card signature verification | Cards verified before use | 100% | < 100% |
| Task completion rate | `COMPLETED` / submitted | ≥ 95% | < 85% |
| Rejection rate | `REJECTED` / submitted | < 5% | > 15% (you are asking for the wrong thing) |
| Interrupted-state handling | `INPUT_REQUIRED` answered | 100% | < 100% |
| Task latency p95 | Submit → terminal | Peer-specific SLA | Beyond it |
| Orphaned tasks | No terminal state recorded | 0 | ≥ 1 |
| Cross-agent trace completeness | Runs traced end to end | 100% | < 95% |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | No A2A. Sub-agents in-process. |
| v1 | Another team owns a step | A2A client: discover, verify, submit, subscribe |
| v2 | Tasks outlive connections | Push-notification configs with authenticated webhooks |
| v3 | You publish a capability | Serve a signed Agent Card; implement the task lifecycle |
| v4 | Cross-organisation | mTLS + OAuth2, per-skill scopes, boundary audit |
| v5 | Many peers | Agent Card registry, policy at the gateway, peer health tracking |

## 12. Build checklist

- [ ] Agent Card signatures are verified before any task is submitted.
- [ ] Credentials travel in headers, never in the payload.
- [ ] Scopes are requested per skill, not as one broad grant.
- [ ] All eight task states are handled; `REJECTED` differs from `FAILED`.
- [ ] `INPUT_REQUIRED` and `AUTH_REQUIRED` are treated as normal states.
- [ ] Tasks longer than ~2 minutes use push notifications, not held streams.
- [ ] Webhook endpoints authenticate the incoming notification.
- [ ] `traceparent` / `tracestate` are propagated in both directions.
- [ ] Every task has a timeout and a cancellation path.
- [ ] Structured input uses `data` parts, not text.
- [ ] The current A2A spec version was verified on the web before building.
- [ ] A2A is used only across real trust boundaries.

## 13. Related

- [agent-protocols-overview.md](agent-protocols-overview.md) — MCP vs A2A vs AG-UI
- [mcp-protocol-overview.md](mcp-protocol-overview.md) — the tool-level protocol
- [orchestrator-workers.md](orchestrator-workers.md) — in-process delegation
- [security-and-secrets.md](security-and-secrets.md) — credential scoping
- [observability-tracing.md](observability-tracing.md) — trace propagation
