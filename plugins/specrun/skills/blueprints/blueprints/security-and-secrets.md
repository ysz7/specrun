+++
id = "security-and-secrets"
title = "Security and secrets"
use_when = "Credential scoping, storage and rotation for a system where a model can call tools, read external content, or serve more than one tenant"
pack = "LLM infrastructure"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Security and Secrets

> Credential scoping, storage, and rotation for AI systems — where the model is not a trust boundary and every capability you grant is one an attacker may eventually reach.

**Tier:** advanced
**Use when:** any system where a model can call tools, read external content, or serve more than one tenant.
**Avoid when:** a fully local prototype with no credentials and no external input. Verify that is actually true.
**Cost profile:** hours of setup. The alternative is measured in breach-notification costs.

---

## 1. Problem it solves

Conventional application security assumes the code decides what to do. In an AI system the *model* decides, and the model's decisions are influenced by whatever text reached its context — including text an attacker wrote in a web page, an email, a document, or a support ticket.

This changes the threat model in one specific way: **you cannot rely on the system behaving as instructed.** Every prompt-level defence has been broken. What holds is what the system is *technically capable of* — the scope of its credentials, the reach of its network, and the gates on its irreversible actions.

Practically, that means the security work is: scope credentials to the minimum, never derive identity from model output, isolate execution, and make every action attributable.

## 2. Shape

```
  ┌─────────────────── what an attacker reaches through the model ──────────────┐
  │                                                                             │
  │  injected text ──▶ model ──▶ tool call ──▶ credential ──▶ your systems      │
  │                     ▲                          │                            │
  │                     │                          ▼                            │
  │              NOT a trust boundary        THIS is the boundary               │
  └─────────────────────────────────────────────────────────────────────────────┘

  CONTROLS, in order of effectiveness
  1. credential scope       read-only role beats any instruction
  2. identity from tokens   never from tool arguments
  3. network egress         allowlist; no arbitrary outbound
  4. execution isolation    container, no net, ro mounts, resource caps
  5. approval gates         irreversible actions only
  6. rate limits            bounds a successful attack
  7. audit log              attribution and reconstruction
  8. output filtering       stop data leaving via URLs and images
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Secret store | Hold credentials outside code | Vault, cloud secret manager | Secrets in env files committed to git |
| Scoped credentials | Least privilege per capability | Per-tool roles and tokens | One admin key for everything |
| Identity resolution | Who is this request for | Auth token → principal | Derived from a tool argument |
| Egress control | Where the system may connect | Allowlist, egress proxy | Open outbound → exfiltration channel |
| Execution sandbox | Contain code the model runs | Container, no net, ro mounts, caps | Host filesystem mounted read-write |
| Approval gates | Human confirmation | Policy table in code | Policy expressed in the prompt |
| Rate limiter | Bound a successful attack | Per-principal, per-tool | Enforced inside the agent loop |
| Audit log | Attribution and reconstruction | Append-only, immutable | Missing the principal, or logging secrets |
| Rotation | Limit credential lifetime | Automated, scheduled | Manual, so never done |
| Output filter | Prevent leaks on the way out | Redaction + URL allowlist | Checks text but not links or images |

## 4. Data flow

1. Secrets load from the secret store at startup or per-request — never from source, never from a committed file.
2. A request arrives with an auth token. The principal — user, tenant, scopes — is derived **from the token only**.
3. Every tool call is authorised against the principal's scopes before dispatch. Unknown tools fail closed.
4. Credentials used for the call are the narrowest available: a read-only database role for reads, a separate write role for writes.
5. Code execution runs in a sandbox with no network, read-only mounts, and CPU/memory/time caps.
6. Actions that leave the sandbox are gated when untrusted content is in context.
7. Outbound content passes the output filter — secrets, PII, and non-allowlisted URLs and images.
8. Everything is written to an append-only audit log with principal, tool, arguments, and outcome. Secrets never appear.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class Principal(BaseModel):
    """Derived from the token. The ONLY source of identity."""
    subject: str
    tenant_id: str
    scopes: set[str]
    auth_method: Literal["oauth", "mtls", "service_token"]
    expires_at: float

class CredentialSpec(BaseModel):
    name: str
    store_ref: str = Field(description="Reference into the secret store. NEVER the value.")
    scope: str = Field(description="e.g. 'db:orders:read'")
    max_ttl_s: int = 3600
    rotation_days: int = 90

class SandboxSpec(BaseModel):
    network: Literal["none", "allowlist"] = "none"
    allowed_hosts: list[str] = Field(default_factory=list)
    mounts_readonly: list[str] = Field(default_factory=list)
    writable_scratch: str = "/tmp/work"
    cpu_limit: float = 1.0
    memory_mb: int = 512
    timeout_s: int = 30
    drop_capabilities: bool = True

class AuditEntry(BaseModel):
    timestamp: float
    trace_id: str
    principal: str
    tenant_id: str
    action: str
    args_redacted: dict
    trust_level: Literal["trusted", "untrusted"]
    decision: Literal["allowed", "gated", "denied"]
    outcome: str
```

## 6. Reference implementation

```python
# ---------- credentials: scoped, short-lived, never in code ----------
CREDENTIALS = {
    "db_read":   CredentialSpec(name="db_read", store_ref="vault:db/orders-ro",
                                scope="db:orders:read", max_ttl_s=3600),
    "db_write":  CredentialSpec(name="db_write", store_ref="vault:db/orders-rw",
                                scope="db:orders:write", max_ttl_s=900),
    "email_api": CredentialSpec(name="email_api", store_ref="vault:email/send",
                                scope="email:send", max_ttl_s=900, rotation_days=30),
}

async def get_credential(name: str, principal: Principal) -> str:
    spec = CREDENTIALS[name]
    if spec.scope not in principal.scopes:
        raise PermissionError(f"Principal lacks {spec.scope}")
    # Short-lived, minted per use. A leaked credential expires on its own.
    return await vault.issue(spec.store_ref, ttl=spec.max_ttl_s,
                             metadata={"principal": principal.subject})

# ---------- the rule that matters most ----------
@tool
def search_orders(ctx, customer_email: str | None = None, status: str | None = None) -> str:
    """Tenant comes from the TOKEN. There is deliberately no tenant argument:
    a tool argument is model-generated and therefore attacker-influenceable."""
    principal = authenticate(ctx)
    authorize(principal, "orders:read")
    cred = await get_credential("db_read", principal)
    audit.log(principal=principal.subject, tenant=principal.tenant_id,
              action="search_orders",
              args_redacted={"customer_email": mask(customer_email), "status": status},
              trust_level=ctx.trust_level, decision="allowed")
    return repo.search(cred, tenant_id=principal.tenant_id,
                       email=customer_email, status=status)

# ---------- sandbox: assume the code inside is hostile ----------
SANDBOX = SandboxSpec(network="none", mounts_readonly=["/app/data"],
                      writable_scratch="/tmp/work", cpu_limit=1.0,
                      memory_mb=512, timeout_s=30, drop_capabilities=True)

async def run_sandboxed(code: str, spec: SandboxSpec) -> tuple[str, bool]:
    result = await container.run(
        image="python:3.12-slim", command=["python", "-c", code],
        network_mode="none" if spec.network == "none" else "allowlist",
        read_only=True,
        mounts=[{"src": m, "dst": m, "mode": "ro"} for m in spec.mounts_readonly]
               + [{"src": tempdir(), "dst": spec.writable_scratch, "mode": "rw"}],
        cpu_quota=spec.cpu_limit, mem_limit=f"{spec.memory_mb}m",
        timeout=spec.timeout_s, cap_drop=["ALL"] if spec.drop_capabilities else [])
    return result.output, result.exit_code == 0
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Credential TTL | 1 h read, 15 min write | Exposure window | Shorter for high-privilege scopes |
| Rotation | 90 days, automated | Long-lived-key risk | 30 days for external-facing credentials |
| Sandbox network | none | Exfiltration | Allowlist only when a specific host is required |
| Sandbox mounts | read-only + scratch | Host integrity | Never a writable host mount |
| Resource caps | 1 CPU, 512 MB, 30 s | Denial of service | Tune to real workloads |
| Egress allowlist | your domains | Data exfiltration | Add hosts one at a time, with review |
| Audit retention | 12 months | Investigation window | Match regulatory requirements |
| Identity source | auth token only | The core control | Never negotiable |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| **Cross-tenant data returned** | Identity from a tool argument | Audit: principal vs data accessed | Remove identity arguments; derive from token |
| Secret in the repository | Committed `.env` or hardcoded key | Secret scanning pre-commit and in CI | **Rotate first**, then remove from history |
| Injected page causes a write | Untrusted content did not revoke auto-execute | Audit trust level vs actions | Gate escaping actions when untrusted content is present |
| Data exfiltrated via a URL | Output filter checked text only | Egress logs to unexpected hosts | Strip markdown images; allowlist link hosts |
| Sandbox escape | Host mounted writable, or network open | Sandbox config review | Read-only mounts, no network, dropped capabilities |
| One key used everywhere | Convenience | Credential usage by scope | Per-capability scoped credentials |
| Cannot attribute an action | Audit lacks the principal | Incident review | Log principal, tenant, action, args, outcome |
| Leaked key valid for months | No rotation, long TTL | Credential age | Automated rotation + short TTLs |
| Secrets in traces and logs | No redaction | Log audit | Redact before write; reference secrets, never embed |
| Rate limits bypassed | Enforced in the agent loop | Actions per principal | Enforce outside the model's reach |

## 9. Anti-patterns

- **Identity as a tool argument.** The defining security mistake in agentic systems. Everything the model emits is attacker-influenceable.
- **One admin credential.** Every compromise becomes total.
- **Security policy in the system prompt.** An injected instruction can argue with a prompt; it cannot argue with a policy table in code.
- **Sandbox with network access.** Exfiltration and lateral movement in one step.
- **Rotating secrets manually.** It means never.
- **Removing a committed secret from history and stopping there.** It was compromised the moment it was pushed. Rotate first.
- **Rate limiting inside the agent loop.** The agent is what you are limiting.
- **Trusting third-party MCP servers.** They run with your credentials and can return instructions.
- **Filtering output text but not URLs and images.** The standard exfiltration channel, routinely forgotten.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Cross-tenant access | Requests serving data outside the principal's tenant | 0 | ≥ 1 (incident) |
| Secrets in code | Scanner findings | 0 | ≥ 1 (rotate) |
| Credential age p95 | Time since rotation | < rotation period | > rotation period |
| Over-scoped credentials | Credentials broader than their use | 0 | ≥ 1 |
| Sandbox escape attempts | Blocked escapes | 0 | ≥ 1 (investigate) |
| Audit completeness | Actions with a principal recorded | 100% | < 100% |
| Egress violations | Blocked non-allowlisted connections | 0 sustained | any recurring pattern |
| Injection test pass rate | Red-team payloads causing an action | 0% | > 0% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | Local prototype | Env vars, gitignored |
| v1 | Deployed anywhere | Secret store, no secrets in code, secret scanning in CI |
| v2 | Model gains tools | Scoped credentials per capability; identity from tokens |
| v3 | Model executes code | Sandbox: no network, read-only mounts, resource caps |
| v4 | Model reads external content | Trust tagging, gates on escaping actions, output filtering |
| v5 | Multi-tenant / regulated | Automated rotation, immutable audit log, red-team suite in CI, retention policy |

## 12. Build checklist

- [ ] No secrets in source, config files, or container images.
- [ ] Secret scanning runs pre-commit **and** blocks PRs.
- [ ] Credentials are scoped per capability; read-only wherever possible.
- [ ] Credentials are short-lived and rotated automatically.
- [ ] Identity and tenancy derive from the auth token; no tool accepts an identity argument.
- [ ] A two-tenant isolation test runs in CI.
- [ ] Unknown tools and unknown scopes fail closed.
- [ ] Code execution is sandboxed: no network, read-only mounts, dropped capabilities, resource caps.
- [ ] Untrusted content in context revokes auto-execution for actions leaving the sandbox.
- [ ] Outbound content is filtered: secrets, PII, non-allowlisted URLs, markdown images.
- [ ] Rate limits are enforced outside the agent loop, per principal and per tool.
- [ ] An append-only audit log records principal, tenant, action, redacted args, and outcome.
- [ ] A red-team payload suite runs in CI.
- [ ] Secret exposure triggers rotation first, cleanup second.

## 13. Related

- [human-in-the-loop.md](human-in-the-loop.md) — gates and sandboxing in detail
- [guardrails-and-injection-defense.md](guardrails-and-injection-defense.md) — the input side
- [mcp-authorization.md](mcp-authorization.md) — OAuth and scoping across a server boundary
- [data-quality-and-pii.md](data-quality-and-pii.md) — data-side obligations
- [cost-and-rate-limits.md](cost-and-rate-limits.md) — rate limits as a containment control
