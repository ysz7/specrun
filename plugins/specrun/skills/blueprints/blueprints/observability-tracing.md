+++
id = "observability-tracing"
title = "Observability and tracing"
use_when = "A production run cannot be reconstructed: no traces of LLM calls and agent steps with inputs, outputs, tokens, cost and outcome, and a user's complaint cannot be reproduced"
pack = "LLM infrastructure"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Observability and Tracing

> Structured traces of every LLM call and agent step — inputs, outputs, tokens, cost, latency, and outcome — so a production failure can be reconstructed and replayed instead of guessed at.

**Tier:** foundational
**Info:** this is the difference between "the agent did something weird yesterday" and a reproducible bug report.

**Use when:** any LLM system running where you cannot watch it.
**Avoid when:** never. Even a prototype benefits; the cost is a JSONL file.
**Cost profile:** storage (traces are large) plus a small async write. Sampling controls it; never sample away the failures.

---

## 1. Problem it solves

Conventional observability answers "was there an error?" LLM systems fail without errors: the call returns 200, the JSON parses, and the answer is wrong. Metrics show a healthy system while users see nonsense.

What you need instead is the ability to answer, for a specific user complaint from yesterday: what exactly went into the model, what came out, which tools ran, what they returned, how many tokens it cost, and where the reasoning diverged. Without a trace, that is unanswerable and the bug is unfixable.

The second reason is economic: token cost is invisible without per-request attribution. Teams routinely discover a 10× cost regression weeks later, on an invoice.

## 2. Shape

```
  request
    │
    ▼
 ┌─────────────────────────── TRACE (one per request) ─────────────────────────┐
 │ trace_id · user · tenant · session · route · outcome · total cost/latency   │
 │                                                                             │
 │  ┌── SPAN: retrieval ──────────────────────────────────────────────┐        │
 │  │ query · k · latency · chunk ids + scores                         │        │
 │  └──────────────────────────────────────────────────────────────────┘       │
 │  ┌── SPAN: llm_call (step 0) ──────────────────────────────────────┐        │
 │  │ model · prompt ref · response ref · tokens in/out/cached · cost  │        │
 │  │ · temperature · stop_reason · latency · TTFT                     │        │
 │  └──────────────────────────────────────────────────────────────────┘       │
 │  ┌── SPAN: tool_call (search_orders) ──────────────────────────────┐        │
 │  │ args · result size · is_error · latency                          │        │
 │  └──────────────────────────────────────────────────────────────────┘       │
 │  ┌── SPAN: llm_call (step 1) ... ───────────────────────────────────┐       │
 │  └──────────────────────────────────────────────────────────────────┘       │
 │                                                                             │
 │ + user feedback (thumbs, correction, escalation) attached later by trace_id │
 └─────────────────────────────────────────────────────────────────────────────┘
        │                                    │
        ▼                                    ▼
   metrics (aggregates)              replay: rebuild the exact input
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Trace context | Correlate everything in one request | OTel context propagation | Lost across async boundaries |
| LLM span | One model call | OTel span + GenAI attributes | Missing token and cost fields |
| Payload store | Prompts and responses | Object storage, referenced by id | Stored inline → traces become enormous |
| Tool span | One tool execution | Span with args and result size | Full result inlined |
| Cost calculator | Tokens → USD | Price table per model | Not updated when prices change |
| Sampler | Control volume | Head or tail sampling | Samples away the failures |
| Feedback link | Attach user signal to a trace | `trace_id` in the client response | No id returned → feedback is unattributable |
| Replay | Rebuild the exact input | From the stored payload | Impossible because prompt assembly is not deterministic |
| PII redaction | Keep sensitive data out of traces | Pre-write filter | Absent → traces become a compliance liability |

## 4. Data flow

1. A `trace_id` is created at the entry point and propagated through every async call.
2. Each LLM call opens a span recording model, parameters, token counts (including cached), cost, latency, TTFT, and `stop_reason`.
3. Prompts and responses are written to a payload store; the span holds **references**, not the text.
4. Tool calls get spans with arguments, result size, error flag, and latency.
5. On completion the trace records the outcome and totals.
6. The `trace_id` is returned to the client so user feedback can be attached later.
7. Sampling: **keep 100% of errors, slow requests, and expensive requests**; sample the rest.
8. Metrics are derived from spans — never emitted separately, or they drift.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class LLMSpan(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str | None
    step_index: int
    model: str
    provider: str
    temperature: float
    # Payload REFERENCES, not payloads. Inlining makes traces unusably large.
    prompt_ref: str
    response_ref: str
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int = 0
    cost_usd: float
    latency_ms: float
    time_to_first_token_ms: float | None = None
    stop_reason: str
    error: str | None = None

class ToolSpan(BaseModel):
    trace_id: str
    span_id: str
    tool_name: str
    args_ref: str
    result_bytes: int
    result_ref: str
    is_error: bool
    latency_ms: float

class Trace(BaseModel):
    trace_id: str
    user_id: str | None
    tenant_id: str | None
    session_id: str | None
    route: str
    outcome: Literal["success", "error", "abstained", "budget_exhausted"]
    total_tokens: int
    total_cost_usd: float
    total_latency_ms: float
    n_llm_calls: int
    n_tool_calls: int
    feedback: dict | None = None      # attached later, by trace_id
```

## 6. Reference implementation

```python
from opentelemetry import trace
from contextlib import asynccontextmanager

tracer = trace.get_tracer("llm-app")

@asynccontextmanager
async def llm_span(model: str, step: int):
    with tracer.start_as_current_span("llm.call") as span:
        span.set_attribute("gen_ai.request.model", model)
        span.set_attribute("llm.step_index", step)
        t0 = time.monotonic()
        try:
            holder = {}
            yield holder
            usage = holder["usage"]
            span.set_attributes({
                "gen_ai.usage.input_tokens": usage.input_tokens,
                "gen_ai.usage.output_tokens": usage.output_tokens,
                "llm.usage.cached_tokens": getattr(usage, "cache_read_input_tokens", 0),
                "llm.cost_usd": cost_of(model, usage),
                "llm.stop_reason": holder["stop_reason"],
                # References, not content.
                "llm.prompt_ref": await payloads.put(holder["prompt"]),
                "llm.response_ref": await payloads.put(holder["response"]),
            })
        except Exception as e:
            span.record_exception(e)
            span.set_status(trace.StatusCode.ERROR)
            raise
        finally:
            span.set_attribute("llm.latency_ms", (time.monotonic() - t0) * 1000)

# ---------- sampling: never sample away what you need ----------
def should_keep(trace: Trace) -> bool:
    if trace.outcome != "success":          return True     # all failures
    if trace.total_latency_ms > 10_000:     return True     # all slow requests
    if trace.total_cost_usd > 0.50:         return True     # all expensive requests
    if trace.feedback:                      return True     # anything a user commented on
    return random.random() < 0.05                            # 5% of healthy traffic

# ---------- redaction before write ----------
def redact(payload: str, policy) -> str:
    """Traces persist for months. Anything sensitive in them is a liability."""
    for pattern in policy.patterns:
        payload = re.sub(pattern, "[REDACTED]", payload)
    return payload
```

Replay — the payoff for storing payloads:

```python
async def replay(trace_id: str, step: int, *, model: str | None = None):
    """Rebuild the EXACT input and re-run it. Requires deterministic prompt assembly:
    if the prompt is reconstructed rather than stored, this is impossible."""
    span = await traces.get_llm_span(trace_id, step)
    prompt = await payloads.get(span.prompt_ref)
    return await client.messages.create(model=model or span.model,
                                        temperature=span.temperature, **prompt)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Base sample rate | 5% of successes | Storage cost | Raise while debugging; failures are always kept |
| Payload retention | 30 days | Storage and compliance | Shorter for sensitive data; keep span metadata longer |
| Span metadata retention | 12 months | Trend analysis | Cheap — keep it |
| Redaction | on | Compliance | Always for anything user-generated |
| Async emission | on | Hot-path latency | Never synchronous |
| Cost table refresh | on price change | Accuracy | Version it; recompute historical cost on change |
| Feedback linkage | `trace_id` in the response | Attribution | Always return it |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Cannot reproduce a user's complaint | Prompt not stored | Try to reproduce one | Store the assembled prompt, not the template |
| Traces cost more than inference | Payloads inlined; no sampling | Storage growth | Reference payloads; sample successes |
| Cost regression found on the invoice | No per-request cost | Cost per request over time | Cost on every span, aggregated daily |
| Trace context lost mid-request | Async boundary drops it | Orphaned spans | Explicit context propagation |
| Feedback cannot be linked | `trace_id` never returned | Feedback with no trace | Return it in the response |
| Traces contain personal data | No redaction | Audit a sample | Redact before write; retention policy |
| Sampling hid the bug | Uniform sampling | Failures absent from traces | Tail-based: always keep errors, slow, expensive |
| Metrics disagree with traces | Emitted independently | Reconcile totals | Derive metrics from spans |
| Replay produces a different prompt | Non-deterministic assembly | Replay mismatch | Store the final assembled prompt |

## 9. Anti-patterns

- **Logging only errors.** The failures that matter return 200 with a wrong answer.
- **Inlining prompts and responses in spans.** Traces become gigabytes and query tooling stops working.
- **Uniform sampling.** You keep the boring traffic and lose the incident.
- **No cost per request.** Cost regressions are discovered monthly, by finance.
- **No `trace_id` in the response.** User feedback becomes unattributable.
- **Synchronous trace writes.** Observability becomes the latency problem.
- **Traces with no retention policy.** They accumulate personal data indefinitely.
- **Metrics emitted separately from spans.** They drift, and then nobody trusts either.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Trace completeness | Requests with a full trace | > 99% | < 95% |
| Failure trace coverage | Failed requests with a trace | 100% | < 100% |
| Replay success rate | Traces that replay to the same prompt | > 95% | < 80% |
| Trace overhead | Added latency p95 | < 5 ms | > 20 ms |
| Storage cost | USD per month | < 5% of inference cost | > 15% |
| Cost attribution | Spend mapped to a trace | 100% | < 98% |
| Feedback linkage | Feedback with a trace | > 95% | < 80% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Structured JSONL: prompt, response, tokens, latency |
| v1 | Multi-step systems | OTel spans with context propagation |
| v2 | Storage cost or trace size | Payload references + tail-based sampling |
| v3 | Cost questions | Per-request cost attribution, daily aggregates |
| v4 | Quality questions | Feedback linkage + online judging of sampled traces |
| v5 | Continuous improvement | Production traces flowing into the eval set; drift detection |

## 12. Build checklist

- [ ] A `trace_id` is created at entry and propagated across async boundaries.
- [ ] Every LLM call emits a span with model, tokens (including cached), cost, latency, and stop reason.
- [ ] Prompts and responses are stored by reference, never inlined in spans.
- [ ] The stored prompt is the **assembled** prompt, so replay is possible.
- [ ] Tool calls emit spans with args, result size, and error flag.
- [ ] Sampling always keeps errors, slow requests, expensive requests, and anything with feedback.
- [ ] Redaction runs before write; retention is defined for payloads and metadata separately.
- [ ] Telemetry is emitted asynchronously.
- [ ] `trace_id` is returned to the client and used to attach feedback.
- [ ] Metrics are derived from spans, not emitted separately.
- [ ] Replay has been used at least once to reproduce a real issue.

## 13. Related

- [gateway-and-routing.md](gateway-and-routing.md) — the natural place to emit spans
- [cost-and-rate-limits.md](cost-and-rate-limits.md) — what cost attribution feeds
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — traces as eval input
