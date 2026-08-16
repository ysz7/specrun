+++
id = "routing"
title = "Routing"
use_when = "Inputs fall into distinct families needing different prompts, models or tools, and one prompt for all of them degrades every case; classifying an input before handling it"
pack = "agent workflows"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Routing

> A classifier (LLM or cheap model) that assigns each input to one of N specialised downstream handlers, so each handler can be optimised for a narrow case.

**Tier:** foundational
**Use when:** inputs fall into distinct families that need different prompts, tools, or models; a single prompt optimised for one family degrades the others.
**Avoid when:** the categories overlap heavily, or classification accuracy is below ~90% — misroutes cost more than a generalist prompt.
**Cost profile:** +1 cheap LLM call (~50–200 tokens out). Usually *net negative* cost, because most traffic routes to a smaller model.

---

## 1. Problem it solves

One prompt serving refunds, technical support, and sales becomes a compromise: every instruction added for one family degrades the others, and the prompt grows past the point where the model follows all of it. Routing lets you optimise per family in isolation and change one without regression-testing the rest.

The second, often bigger win: cost. Route the 70% of easy traffic to a small model and the 30% of hard traffic to the frontier model.

## 2. Shape

```
                       ┌────────────────┐
   input ─────────────▶│   classifier   │  (cheap model, temperature 0)
                       └───┬───┬────┬───┘
       ┌───────────────────┘   │    └────────────────────┐
       │ refund                │ tech                    │ unknown / low conf
       ▼                       ▼                         ▼
┌──────────────┐      ┌────────────────┐        ┌─────────────────┐
│ refund chain │      │ tech agent     │        │ fallback:       │
│ small model  │      │ frontier model │        │ generalist or   │
│ 2 tools      │      │ 9 tools        │        │ human handoff   │
└──────────────┘      └────────────────┘        └─────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Classifier | Input → route label + confidence | Small LLM, or fine-tuned encoder, or embeddings + kNN | Labels not mutually exclusive |
| Route table | Label → handler config (prompt, model, tools) | Dict / config file | Hardcoded in the classifier prompt |
| Handlers | Specialised chains/agents | Any pattern in this folder | Silent drift between handlers |
| Fallback | Handles low confidence and unknown labels | Generalist handler or human | Absent → misroute becomes a hard failure |
| Reclassify hook | Handler can bounce back a misroute | Return sentinel → re-route once | Infinite bounce loop |

## 4. Data flow

1. Input arrives; optional deterministic pre-routes fire first (regex on order IDs, explicit user selection).
2. Classifier emits `{label, confidence, reason}` at temperature 0.
3. If `confidence < threshold` or label unknown → fallback handler.
4. Route table resolves label → handler config.
5. Handler runs; may return `REROUTE(label)` once, at most.
6. Log `(input_hash, label, confidence, handler, outcome)` for the confusion matrix.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

Label = Literal["refund", "technical", "sales", "account", "other"]

class RouteDecision(BaseModel):
    label: Label
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(max_length=200, description="One line. Used for audits, not shown to users.")

class HandlerConfig(BaseModel):
    model: str
    system_prompt_path: str
    tools: list[str]
    max_steps: int = 8
    escalate_to_human: bool = False
```

## 6. Reference implementation

```python
import json
from anthropic import Anthropic

client = Anthropic()

ROUTER_SYSTEM = """Classify the user's message into exactly one category.

refund     — money back, cancellations, billing disputes, chargebacks
technical  — product not working, errors, bugs, setup and integration help
sales      — pricing, plans, upgrades, pre-purchase questions
account    — login, password, permissions, seat management
other      — anything that fits none of the above, or fits two equally

Rules:
- Choose `other` when two categories fit equally. Do not guess.
- Judge the user's INTENT, not the words. "I can't log in to cancel" is `refund`.
- confidence is your probability that a human would agree. Be calibrated.
Return JSON: {"label": ..., "confidence": 0.0-1.0, "reason": "..."}"""

ROUTES: dict[str, HandlerConfig] = {
    "refund":    HandlerConfig(model="<SMALL_MODEL>", system_prompt_path="prompts/refund.md",
                               tools=["lookup_order", "issue_refund"], max_steps=6),
    "technical": HandlerConfig(model="<FRONTIER_MODEL>", system_prompt_path="prompts/tech.md",
                               tools=["search_docs", "get_logs", "run_diagnostic"], max_steps=12),
    "sales":     HandlerConfig(model="<SMALL_MODEL>", system_prompt_path="prompts/sales.md",
                               tools=["get_pricing"], max_steps=4),
    "account":   HandlerConfig(model="<SMALL_MODEL>", system_prompt_path="prompts/account.md",
                               tools=["get_user", "reset_password"], max_steps=6),
    "other":     HandlerConfig(model="<FRONTIER_MODEL>", system_prompt_path="prompts/generalist.md",
                               tools=["search_docs"], max_steps=8, escalate_to_human=True),
}

CONFIDENCE_THRESHOLD = 0.7

def classify(text: str) -> RouteDecision:
    resp = client.messages.create(
        model="<SMALL_MODEL>", max_tokens=200, temperature=0,
        system=ROUTER_SYSTEM,
        messages=[{"role": "user", "content": text}],
    )
    return RouteDecision.model_validate_json(resp.content[0].text)

def route(text: str):
    # Deterministic pre-routes beat the classifier — use them where they exist.
    if text.strip().lower().startswith("order #"):
        decision = RouteDecision(label="refund", confidence=1.0, reason="explicit order id")
    else:
        decision = classify(text)

    label = decision.label if decision.confidence >= CONFIDENCE_THRESHOLD else "other"
    cfg = ROUTES[label]
    log_route(text, decision, label)
    return cfg, decision
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Category count | 3–7 | Classifier accuracy | Above ~8, use a two-level hierarchy |
| Confidence threshold | 0.7 | Fallback rate vs misroute rate | Raise if misroutes are expensive; lower if fallback is overloaded |
| Classifier model | small | Cost and latency | Upgrade only if the confusion matrix says so |
| Classifier temperature | 0 | Determinism | Always 0 |
| Reroute budget | 1 | Recovery from misroutes | Never > 1 |
| Few-shot examples | 2–4 per ambiguous pair | Boundary accuracy | Add examples for the exact pairs the matrix shows confused |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Two categories constantly confused | Boundary undefined | Confusion matrix on labelled set | Add explicit boundary rules + few-shots for that pair; consider merging |
| Confidence always ~0.95 | Model not calibrated | Confidence histogram | Ask for calibration explicitly; or calibrate empirically and shift the threshold |
| Fallback handles 30% of traffic | Threshold too high or a real missing category | Fallback rate | Inspect fallback inputs; usually reveals a needed category |
| Handler quality diverges | Prompts edited independently | Per-route success rate | Per-route eval sets in CI |
| Multi-intent messages misrouted | Routing assumes one intent | Manual review of failures | Route on primary intent + let the handler hand off; or allow multi-label |
| Router adds unacceptable latency | Serial classify-then-handle | Latency breakdown | Speculatively start the most-likely handler; or use an embedding kNN router (~10 ms) |

## 9. Anti-patterns

- **Routing with overlapping categories.** If a human labeller cannot agree with themselves twice, the model cannot either. Fix the taxonomy first.
- **No fallback.** Every classifier is wrong sometimes; without a fallback that becomes a hard failure.
- **Route labels baked into the classifier prompt only.** Keep the route table in config so adding a route does not mean editing a prompt string.
- **Using the frontier model to classify.** Classification is the easiest task in the system; use the cheapest model that clears the accuracy bar.
- **Ignoring confidence.** A 0.35-confidence route is a coin flip dressed as a decision.
- **Reroute loops.** Cap at one bounce, then fall back.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Classification accuracy | vs human-labelled set (≥ 200 examples) | ≥ 92% | < 88% |
| Fallback rate | routed to `other` / total | 5–15% | > 25% |
| Reroute rate | handler bounced / total | < 3% | > 8% |
| Cost per request | blended across routes | ↓ vs generalist baseline | Above baseline |
| Router latency | p95 | < 300 ms | > 800 ms |
| Per-route success | task success by label | ≥ 85% each | any route < 75% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Keyword/regex rules, 2–3 routes |
| v1 | Rules miss too much | LLM classifier + confidence + fallback |
| v2 | Latency or cost of classification | Embedding kNN router over labelled examples |
| v3 | > 8 categories | Two-level hierarchy: coarse route → sub-router |
| v4 | Labelled data accumulates | Fine-tuned encoder classifier; LLM only for the fallback |

## 12. Build checklist

- [ ] Categories are mutually exclusive and collectively exhaustive (`other` exists).
- [ ] A labelled set of ≥ 200 real inputs measures accuracy.
- [ ] A confusion matrix is reviewed and drives few-shot additions.
- [ ] Confidence is returned and a threshold is enforced.
- [ ] A fallback handler exists and is monitored.
- [ ] The route table is configuration, not prompt text.
- [ ] Deterministic pre-routes handle the cases where rules are exact.
- [ ] Each route has its own eval set.
- [ ] Reroutes are capped at one.

## 13. Related

- [prompt-chaining.md](prompt-chaining.md) — typical handler shape
- [agent-loop.md](agent-loop.md) — handler for open-ended routes
- [orchestrator-workers.md](orchestrator-workers.md) — when one input needs several handlers, not one
- [eval-harness-design.md](eval-harness-design.md) — building the labelled set
