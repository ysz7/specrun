+++
id = "gateway-and-routing"
title = "LLM gateway"
use_when = "More than one service or provider is being called, and keys, retries, fallbacks, caching, quotas and cost attribution should sit in one place in front of them"
pack = "LLM infrastructure"
verified_at = 2026-08-12
stale_after = "90d"
+++

# LLM Gateway and Routing

> A single service in front of every model provider that centralises keys, retries, fallbacks, caching, rate limiting, cost accounting, and tracing — so application code never talks to a provider SDK directly.

**Tier:** intermediate
**Use when:** more than one service calls models, more than one provider is in use, or you need per-team cost attribution and quotas.
**Avoid when:** one application, one provider, one team. A shared client module is enough; a gateway adds a hop and a failure domain.
**Cost profile:** one extra network hop (~5–20 ms). Usually cost-*negative* because of caching and model routing.

---

## 1. Problem it solves

Without a gateway, every service reimplements the same six things — retries, timeouts, fallbacks, key handling, cost tracking, tracing — each slightly differently and each slightly wrong. Then the questions arrive that nobody can answer: which team spent that $40k, why did latency spike at 3am, can we switch providers this quarter, who is using the deprecated model.

A gateway makes those questions answerable by construction, and makes provider choice a config change rather than a migration.

The trade is real: it becomes a single point of failure on the critical path of everything. It must be simpler and more reliable than what it fronts.

## 2. Shape

```
  services ──┐
             │  one internal API, one auth model
             ▼
  ┌──────────────────────────────────────────────────────────┐
  │                        GATEWAY                            │
  │  auth/quota ─▶ cache ─▶ router ─▶ rate limit ─▶ retry    │
  │      │          │         │           │           │       │
  │      │          │         │           │           └─ fallback chain
  │      │          │         │           └─ per-key token buckets
  │      │          │         └─ model selection: task, cost, health
  │      │          └─ exact-match + semantic (optional)      │
  │      └─ per-team key, quota, allowed models               │
  │                                                           │
  │  emits: trace span, tokens, cost, latency, cache status   │
  └────────────┬──────────────┬──────────────┬────────────────┘
               ▼              ▼              ▼
          provider A     provider B     self-hosted
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Auth layer | Identify the calling team/service | Internal keys or mTLS | Shared key → no attribution |
| Quota enforcer | Per-team spend and rate caps | Token buckets in Redis | Enforced per instance, not globally |
| Cache | Return identical responses | Exact-match on request hash | Caching non-deterministic or personalised responses |
| Router | Pick model and provider | Policy: task, cost, health, latency | Hardcoded model names in application code |
| Rate limiter | Stay inside provider quotas | Distributed token bucket | Counts requests but not tokens |
| Retry/fallback | Survive transient failures | Backoff + provider fallback chain | Retrying non-idempotent calls; no jitter |
| Normaliser | One request/response shape | Adapter per provider | Leaks provider-specific fields |
| Telemetry | Tokens, cost, latency, cache status | OTel spans + metrics | Missing the prompt/response ids for debugging |
| Circuit breaker | Stop hammering a failing provider | Per-provider state | Absent → cascading timeouts |

## 4. Data flow

1. Service calls the gateway with an internal key and a **logical model alias** (`fast`, `smart`, `embed`) rather than a provider model id.
2. Auth resolves the caller; quota check runs before any work.
3. Cache lookup on a hash of the normalised request. A hit returns immediately, tagged as cached.
4. Router resolves the alias to a concrete provider and model, using policy plus current health.
5. Rate limiter admits or queues, counting **both** requests and tokens.
6. Call the provider with a timeout. On failure: retry with jittered backoff, then fall back to the next provider in the chain.
7. Normalise the response; record tokens, cost, latency, cache status, provider, and model on the trace span.
8. Return, with the resolved model and cost echoed in headers so callers can see what they got.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class GatewayRequest(BaseModel):
    model_alias: str = Field(description="'fast' | 'smart' | 'embed'. NEVER a provider model id.")
    messages: list[dict]
    max_tokens: int = 4096
    temperature: float = 0.0
    tools: list[dict] | None = None
    cache: bool = True
    trace_id: str | None = None
    tenant_id: str | None = Field(None, description="For attribution and per-tenant quotas.")

class GatewayResponse(BaseModel):
    content: list[dict]
    resolved_model: str = Field(description="What actually served it — echo it back.")
    provider: str
    tokens: dict[str, int]
    cost_usd: float
    cache_status: Literal["hit", "miss", "bypass"]
    latency_ms: float
    fallbacks_used: int = 0

class RoutePolicy(BaseModel):
    alias: str
    chain: list[tuple[str, str]] = Field(description="[(provider, model)] tried in order.")
    max_cost_per_call_usd: float | None = None
    timeout_s: float = 60.0
    retries: int = 2
```

## 6. Reference implementation

```python
import asyncio, hashlib, json, random, time

ROUTES = {
    "fast":  RoutePolicy(alias="fast",
                         chain=[("anthropic", "<FAST_MODEL>"), ("openai", "<FAST_ALT>")],
                         timeout_s=20),
    "smart": RoutePolicy(alias="smart",
                         chain=[("anthropic", "<FRONTIER_MODEL>"), ("anthropic", "<FAST_MODEL>")],
                         timeout_s=120, max_cost_per_call_usd=2.00),
}

def request_hash(req: GatewayRequest) -> str:
    """Cache key must exclude trace ids and anything per-request-unique."""
    payload = req.model_dump(exclude={"trace_id", "cache"})
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

async def handle(req: GatewayRequest, caller: Principal) -> GatewayResponse:
    await quota.check(caller.team, req)                      # before any spend

    # Only deterministic requests are cacheable. temperature > 0 means a fresh sample.
    cacheable = req.cache and req.temperature == 0
    key = request_hash(req)
    if cacheable and (hit := await cache.get(key)):
        return hit.model_copy(update={"cache_status": "hit"})

    policy = ROUTES[req.model_alias]
    last_error, fallbacks = None, 0

    for provider, model in policy.chain:
        if breaker.is_open(provider):                        # skip a known-bad provider
            fallbacks += 1
            continue
        await limiter.acquire(provider, estimated_tokens(req))

        for attempt in range(policy.retries + 1):
            t0 = time.monotonic()
            try:
                raw = await asyncio.wait_for(
                    adapters[provider].call(model, req), timeout=policy.timeout_s)
                resp = normalise(raw, provider, model,
                                 latency_ms=(time.monotonic() - t0) * 1000,
                                 fallbacks=fallbacks)
                breaker.record_success(provider)
                await telemetry.record(caller, req, resp)
                if cacheable:
                    await cache.set(key, resp, ttl=3600)
                return resp.model_copy(update={"cache_status": "miss"})

            except (RateLimitError, TransientError) as e:
                last_error = e
                breaker.record_failure(provider)
                await asyncio.sleep(min(2 ** attempt, 30) * (0.5 + random.random()))
            except (BadRequestError, AuthError):
                raise                                        # never retry or fall back on these
        fallbacks += 1

    raise GatewayError(f"All providers failed for alias {req.model_alias!r}: {last_error}")
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Model aliases | `fast` / `smart` / `embed` | Decoupling from providers | Always — application code must not name models |
| Cache TTL | 1 h | Hit rate vs staleness | Longer for stable, deterministic workloads |
| Cache condition | `temperature == 0` | Correctness | Never cache sampled or personalised responses |
| Retries | 2 | Transient tolerance | Jittered backoff, capped |
| Timeout | 20 s fast, 120 s smart | Tail latency | Match the alias's expected work |
| Fallback chain | 2 entries | Availability | Cross-provider for true redundancy |
| Circuit breaker | 5 failures / 30 s | Cascade prevention | Tighten for latency-sensitive paths |
| Per-team quota | monthly USD + RPM | Blast radius | Always set both |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Gateway outage takes down everything | Single point of failure | Availability | Multiple instances, health checks, a documented direct-call bypass |
| Cached responses are wrong | Cached a `temperature > 0` or personalised call | User reports of repeated answers | Cache only deterministic requests; exclude tenant-specific content from the key |
| Costs unattributable | Shared internal key | Cost by team is flat | Per-team keys, enforced |
| Rate limits still hit | Limiter is per instance | 429s despite headroom | Distributed limiter in Redis |
| Fallback made it worse | Fell back to a weaker model silently | Quality drop correlated with fallback rate | Echo `resolved_model`; alert on fallback rate |
| Retry storms | No jitter | Synchronised error spikes | Full jitter, capped backoff |
| Non-idempotent retries duplicate work | Retrying a tool-executing call | Duplicate side effects | Only retry before side effects; idempotency keys |
| Cannot debug a bad response | No request/response ids on the span | Support escalations | Record ids and a redacted payload reference |
| Gateway adds 200 ms | Synchronous telemetry writes | Latency breakdown | Emit telemetry asynchronously |

## 9. Anti-patterns

- **Provider model ids in application code.** Every model change becomes a deploy across every service.
- **Caching non-deterministic responses.** Users get identical answers to different questions, or another tenant's answer.
- **One shared API key.** No attribution, no quotas, no revocation granularity.
- **Per-instance rate limiting.** Works with one replica, fails on three.
- **Silent fallback to a weaker model.** Quality drops and nobody knows why.
- **Retrying 4xx errors.** They are deterministic; you are just spending money.
- **Building a gateway for one service.** A shared client module gives you most of the benefit with no new failure domain.
- **Synchronous telemetry on the hot path.** The observability layer becomes the latency problem.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Gateway availability | Successful / total requests | ≥ 99.9% | < 99.5% |
| Added latency p95 | Gateway overhead excluding provider | < 20 ms | > 100 ms |
| Cache hit rate | Cached / cacheable requests | > 25% | < 5% |
| Fallback rate | Requests using a fallback | < 1% | > 5% |
| Retry rate | Retried / total | < 3% | > 10% |
| Cost attribution | Spend mapped to a team | 100% | < 95% |
| Circuit breaker opens | Per provider per day | < 1 | > 5 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | One service | Provider SDK directly |
| v1 | Several services | Shared client module: retries, timeouts, telemetry |
| v2 | Cost is unattributable | Gateway service with per-team keys and quotas |
| v3 | Provider outages hurt | Fallback chains, circuit breakers, health-aware routing |
| v4 | Cost pressure | Response caching; routing cheap traffic to small models |
| v5 | Multi-region / high volume | Regional deployments, distributed limiting, provider-load-aware routing |

## 12. Build checklist

- [ ] Application code uses logical aliases, never provider model ids.
- [ ] Per-team keys with enforced spend and rate quotas.
- [ ] Cache is restricted to deterministic requests; keys exclude trace ids and per-tenant content.
- [ ] Rate limiting is distributed and counts both requests and tokens.
- [ ] Retries use jittered, capped backoff and never fire on 4xx.
- [ ] Fallback chains cross providers; `resolved_model` is echoed to the caller.
- [ ] Circuit breakers skip unhealthy providers.
- [ ] Every request emits a span with tokens, cost, latency, cache status, provider, and model.
- [ ] Telemetry is emitted asynchronously.
- [ ] The gateway runs multiple instances with health checks.
- [ ] A documented bypass exists for a total gateway outage.

## 13. Related

- [cost-and-rate-limits.md](cost-and-rate-limits.md) — quota and budget design
- [observability-tracing.md](observability-tracing.md) — what the spans should carry
- [security-and-secrets.md](security-and-secrets.md) — key storage and rotation
- [prompt-caching.md](prompt-caching.md) — provider-side caching, a different mechanism
