+++
id = "human-in-the-loop"
title = "Human in the loop"
use_when = "An agent can spend money, message people, delete data or write to production, and some actions need an approval gate, a sandbox or a dry run before they execute"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Human-in-the-Loop (Approval Gates and Sandboxing)

> The control layer that classifies every agent action by reversibility and blast radius, then decides — before execution — whether it runs freely, runs in a sandbox, or waits for a human.

**Tier:** intermediate
**Use when:** the agent can take actions with real-world consequences: money, external communication, data deletion, production writes, code merges.
**Avoid when:** every action is read-only and confined to a sandbox. Gates on safe actions train users to click "approve" without reading, which is worse than no gate at all.
**Cost profile:** zero tokens. Costs human attention — the scarcest resource in the system. Spend it only where it changes an outcome.

---

## 1. Problem it solves

An agent that can act will eventually act wrongly: a hallucinated argument, a misread instruction, a prompt injection in a fetched web page. The question is not whether but what it can reach when it does.

Two bad equilibria are common. **Approve-everything** floods the user until they approve reflexively — the gate exists but stops nothing. **Approve-nothing** ships an agent with production credentials and no undo. The engineering work is the classification in between: which actions are cheap to undo (let them run), which are contained (sandbox them), and which are irreversible (gate them).

Prompt injection makes this structural rather than optional. If your agent reads untrusted content — web pages, emails, user files, tool results from third-party systems — assume an attacker can put instructions in front of it. The only reliable defence is that the agent's *capabilities* are constrained, not that its *prompt* says to be careful.

## 2. Shape

```
   agent proposes action
            │
            ▼
   ┌──────────────────┐
   │  classifier      │  reversibility × blast radius × trust of input source
   └───┬──────┬───┬───┘
       │      │   │
  AUTO │  SANDBOX │ GATE
       │      │   │
       ▼      ▼   ▼
 ┌────────┐ ┌────────────┐  ┌─────────────────────────┐
 │ execute│ │ execute in │  │ render preview:         │
 │ + log  │ │ container  │  │  action · args · diff   │
 └────────┘ │ no net,    │  │  · why · reversibility  │
            │ ro mounts, │  └───────┬─────────────────┘
            │ cpu/mem cap│    approve│ edit │ reject │ timeout
            └─────┬──────┘           ▼      ▼        ▼
                  ▼             execute  execute  return refusal
            diff → GATE if                (edited) to agent as
            it escapes                              a tool result
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Action classifier | Map (tool, args) → AUTO / SANDBOX / GATE | Static policy table, not an LLM | LLM-based classification — injectable |
| Policy table | Declarative rules, versioned, reviewed | YAML/code, in the repo | Rules in prompt text where the model can be talked out of them |
| Preview renderer | Show exactly what will happen | Diffs, dry-run output, rendered message | Showing raw JSON args nobody reads |
| Approval channel | Reach the human where they are | UI, Slack, email, CLI | No timeout → agent hangs forever |
| Sandbox | Contain execution | Container, no network, read-only mounts, resource caps | Mounting the host filesystem read-write |
| Audit log | Immutable record of proposal, decision, outcome | Append-only store | Logging the decision but not the args |
| Undo path | Reverse an approved action | Soft deletes, drafts, revert commits | Assumed to exist; never tested |
| Rate limiter | Cap actions per unit time | Counters per tool | Absent → one bad loop sends 400 emails |

## 4. Data flow

1. Agent emits a tool call. **Nothing executes yet.**
2. Classifier evaluates `(tool, args, input_trust_level)` against the policy table.
3. `AUTO` → execute, log, return result.
4. `SANDBOX` → execute in an isolated environment; inspect the produced diff/effect; if it stays inside the sandbox, return it; if it must escape (write to a real repo, send a real request), escalate to `GATE`.
5. `GATE` → render a preview (diff, dry-run, the literal message to be sent), send to the approval channel with a deadline.
6. Human approves / edits / rejects / times out.
7. Approve → execute. Edit → execute the edited args, and log both versions. Reject or timeout → return a tool result explaining the refusal, so the agent can adapt rather than retry blindly.
8. Log proposal, decision, actor, timestamp, and outcome. Always.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime

Reversibility = Literal["free", "cheap", "expensive", "impossible"]
Radius        = Literal["sandbox", "self", "team", "external"]
Mode          = Literal["auto", "sandbox", "gate", "deny"]

class ActionPolicy(BaseModel):
    tool: str
    reversibility: Reversibility
    blast_radius: Radius
    mode: Mode
    rate_limit_per_hour: int | None = None
    requires_role: str | None = None
    arg_conditions: dict[str, str] = Field(
        default_factory=dict,
        description="Escalate on arg values, e.g. {'amount_usd': '> 100'}")

class ApprovalRequest(BaseModel):
    id: str
    tool: str
    args: dict
    preview: str = Field(description="Human-readable. A diff, a dry-run, or the literal payload.")
    rationale: str = Field(description="The agent's stated reason. Shown, never trusted.")
    reversible: Reversibility
    deadline: datetime
    trust_level: Literal["trusted", "untrusted"] = Field(
        description="untrusted if any input came from web/email/third-party content")

class ApprovalDecision(BaseModel):
    request_id: str
    decision: Literal["approve", "edit", "reject", "timeout"]
    edited_args: dict | None = None
    actor: str
    reason: str | None = None
    decided_at: datetime
```

## 6. Reference implementation

```python
POLICIES = {
    # Free and contained → never ask.
    "read_file":        ActionPolicy(tool="read_file", reversibility="free",
                                     blast_radius="sandbox", mode="auto"),
    "search_web":       ActionPolicy(tool="search_web", reversibility="free",
                                     blast_radius="sandbox", mode="auto"),
    # Cheap to undo, stays local → run it, don't interrupt.
    "write_file":       ActionPolicy(tool="write_file", reversibility="cheap",
                                     blast_radius="self", mode="auto"),
    "git_commit":       ActionPolicy(tool="git_commit", reversibility="cheap",
                                     blast_radius="self", mode="auto"),
    # Arbitrary code → sandbox, then judge the diff.
    "run_command":      ActionPolicy(tool="run_command", reversibility="expensive",
                                     blast_radius="self", mode="sandbox"),
    # Leaves the building or cannot be unsent → always a human.
    "send_email":       ActionPolicy(tool="send_email", reversibility="impossible",
                                     blast_radius="external", mode="gate",
                                     rate_limit_per_hour=10),
    "git_push":         ActionPolicy(tool="git_push", reversibility="expensive",
                                     blast_radius="team", mode="gate"),
    "issue_refund":     ActionPolicy(tool="issue_refund", reversibility="expensive",
                                     blast_radius="external", mode="gate",
                                     requires_role="support_lead",
                                     arg_conditions={"amount_usd": "> 100"}),
    "delete_records":   ActionPolicy(tool="delete_records", reversibility="impossible",
                                     blast_radius="team", mode="deny"),  # soft-delete tool instead
}

def classify(tool: str, args: dict, trust: str) -> Mode:
    p = POLICIES.get(tool)
    if p is None:
        return "gate"                      # unknown tool: fail closed, never fail open

    # Untrusted input in context removes AUTO privileges for anything that leaves the sandbox.
    if trust == "untrusted" and p.blast_radius != "sandbox":
        return "gate"

    for arg, condition in p.arg_conditions.items():
        if arg in args and eval(f"{args[arg]!r} {condition}"):   # use a real expression parser
            return "gate"
    return p.mode

async def execute_with_gate(tool, args, ctx) -> str:
    mode = classify(tool.name, args, ctx.trust_level)

    if mode == "deny":
        return (f"Action {tool.name} is not permitted. "
                f"Use a reversible alternative or ask the user to do it manually.")

    if mode == "auto":
        return await run(tool, args)

    if mode == "sandbox":
        result, effect = await run_sandboxed(tool, args)      # no net, ro mounts, cpu/mem caps
        if effect.escapes_sandbox:
            mode = "gate"
        else:
            return result

    req = ApprovalRequest(
        id=new_id(), tool=tool.name, args=args,
        preview=render_preview(tool, args),                   # diff / dry-run / literal payload
        rationale=ctx.last_assistant_reasoning,
        reversible=POLICIES[tool.name].reversibility,
        deadline=now() + timedelta(minutes=30),
        trust_level=ctx.trust_level)

    audit.log("proposed", req)
    decision = await approval_channel.ask(req)                # returns timeout on deadline
    audit.log("decided", decision)

    if decision.decision == "approve":
        return await run(tool, args)
    if decision.decision == "edit":
        return await run(tool, decision.edited_args)
    # Reject/timeout must come back as an actionable tool result, not an exception.
    return (f"A human {decision.decision}ed this action"
            + (f": {decision.reason}" if decision.reason else "")
            + ". Do not retry the same action. Propose an alternative or ask the user.")
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Unknown-tool default | `gate` | Fail-closed safety | Never change to `auto` |
| Approval deadline | 30 min | Agent liveness | Match the channel: 5 min for interactive, hours for async |
| Timeout behaviour | reject | Safety | Never auto-approve on timeout |
| Untrusted-input escalation | on | Injection defence | Keep on whenever the agent reads external content |
| Rate limits | per tool | Blast radius of a loop | Set on anything external-facing |
| Sandbox network | none | Exfiltration risk | Allowlist specific hosts only when required |
| Sandbox mounts | read-only | Host integrity | Write access only to a scratch dir |
| Batch approvals | off | Attention efficiency | On for many similar low-risk actions, with a per-item diff |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Users approve without reading | Too many gates, or previews are unreadable | Time-to-approve p50 (< 3 s = rubber-stamping) | Cut gates to genuinely irreversible actions; make previews diffs, not JSON |
| Agent takes a harmful action from a fetched web page | Prompt injection with `auto` privileges | Trust-level tagging in traces | Untrusted input → gate everything that leaves the sandbox |
| Agent hangs indefinitely | No approval deadline | Runs stuck in `awaiting_approval` | Deadline + timeout → reject |
| Rejected action retried in a loop | Refusal returned as an exception, not context | Repeated identical proposals | Return refusals as tool results with "do not retry" |
| One bug sends 400 emails | No rate limit | Actions per tool per hour | Per-tool rate limits, enforced outside the agent |
| Sandbox escape | Host mounted read-write, or network open | Sandbox config review | Read-only mounts, no network, dropped capabilities, resource caps |
| Cannot reconstruct what happened | Decision logged without args | Audit review | Log proposal args, preview, decision, actor, and outcome |
| Policy bypassed by a new tool | Registration path skipped the policy table | Startup assertion | Fail startup if any registered tool lacks a policy |
| Approved action cannot be undone | Undo path never tested | Disaster drill | Test the revert path in CI like any other feature |

## 9. Anti-patterns

- **Gating everything.** Attention is finite; a gate everyone clicks through is theatre. Gate irreversibility, not activity.
- **Policy expressed in the system prompt.** "Always ask before sending email" is a suggestion an injected instruction can override. Policy lives in code, outside the model's reach.
- **An LLM as the safety classifier.** It is exactly the component an attacker controls. Use a static table.
- **Auto-approve on timeout.** Converts an unavailable human into a silent yes.
- **Previews that are `{"to": "...", "subject": "..."}`.** Show the rendered email, the actual diff, the dry-run output.
- **Trusting `rationale`.** The agent's stated reason is displayed for context and carries zero authority.
- **Sandbox with host network access.** Exfiltration and lateral movement in one step.
- **No `deny` tier.** Some actions should not be reachable at all; give the agent a reversible alternative (soft-delete, draft) instead.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Gate rate | Actions gated / total | 2–10% | > 25% (gate fatigue) |
| Approval rate | Approved / gated | 80–95% | > 98% (gates too lax) or < 60% (agent poorly aligned) |
| Time-to-approve p50 | Decision latency | 10 s – 2 min | < 3 s (rubber-stamping) |
| Edit rate | Edited / gated | < 15% | > 30% (agent proposes wrong args) |
| Timeout rate | Timed out / gated | < 5% | > 15% |
| Unauthorised action rate | Actions executed outside policy | 0 | ≥ 1 (incident) |
| Sandbox escape attempts | Blocked escapes | 0 | ≥ 1 (investigate) |
| Audit completeness | Actions with a full log record | 100% | < 100% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Read-only tools. No gates needed. |
| v1 | Agent gains write tools | Sandbox all execution; writes confined to scratch |
| v2 | Actions reach the outside world | Static policy table + gate on irreversible actions |
| v3 | Agent reads untrusted content | Trust tagging; untrusted input revokes `auto` for escaping actions |
| v4 | Multiple users / roles | Role-based approval, per-tool rate limits, immutable audit log |
| v5 | Regulated or high-volume | Batch approvals with per-item diffs, retention policy, disaster drills for undo |

## 12. Build checklist

- [ ] Every registered tool has a policy entry; startup fails if one is missing.
- [ ] Unknown tools default to `gate`, never `auto`.
- [ ] Policy lives in code/config, not in prompt text.
- [ ] The classifier is deterministic — no LLM in the safety path.
- [ ] Inputs from web/email/third-party tools are tagged `untrusted` and escalate escaping actions.
- [ ] Previews are diffs, dry-runs, or literal payloads — never raw args.
- [ ] Every gate has a deadline; timeout means reject.
- [ ] Rejections return to the agent as tool results saying "do not retry".
- [ ] Per-tool rate limits are enforced outside the agent loop.
- [ ] Sandbox: no network, read-only mounts, dropped capabilities, CPU/memory/time caps.
- [ ] Audit log records proposal args, preview, decision, actor, and outcome, append-only.
- [ ] The undo path for every `expensive` action is tested in CI.
- [ ] A `deny` tier exists, with a reversible alternative offered to the agent.

## 13. Related

- [agent-loop.md](agent-loop.md) — where the gate wraps dispatch
- [tool-design.md](tool-design.md) — designing reversible tools reduces how much gating you need
- [guardrails-and-injection-defense.md](guardrails-and-injection-defense.md) — the input side of the same problem
- [security-and-secrets.md](security-and-secrets.md) — credential scoping so a breach is bounded
