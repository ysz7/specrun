+++
id = "cost-and-rate-limits"
title = "Cost and rate limits"
use_when = "Token spend is unpredictable or unattributable, the bill grows faster than usage, or provider 429s are reaching users"
pack = "LLM infrastructure"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Cost and Rate Limits

> Making token spend predictable and bounded — per request, per user, per team — and staying inside provider quotas without the whole system stalling.

**Tier:** intermediate
**Use when:** spend is material, growing faster than usage, or unattributable; or 429s are affecting users.
**Avoid when:** a prototype with a hard-capped provider key. Set the cap and move on.
**Cost profile:** the controls are nearly free. The absence of them is what costs money.

---

## 1. Problem it solves

LLM cost is unusual in two ways: it is **unbounded per request** (an agent loop can spend a hundred times its median on one input), and it is **invisible at write time** (nothing in the code says `$0.40`). Together they produce the standard incident: a change ships, the bill triples, and nobody notices for three weeks.

Rate limits are the other half. Providers cap both requests per minute and tokens per minute, and hitting either produces 429s that, handled naively, turn into retry storms that make the problem worse.

The remedy is boring and effective: **budget per request, attribute per caller, limit both dimensions, and alert on the derivative, not the absolute.**

## 2. Shape

```
   request
     │
     ▼
 ┌──────────────────────────────────────────────────────┐
 │ BUDGET CHECK (before spending)                        │
 │  per-request cap · per-user daily · per-team monthly  │
 └───────────────┬──────────────────────────────────────┘
                 ▼
 ┌──────────────────────────────────────────────────────┐
 │ RATE LIMIT (distributed, TWO dimensions)              │
 │   requests/min bucket    AND    tokens/min bucket     │
 │   both must admit                                     │
 └───────────────┬──────────────────────────────────────┘
                 ▼
 ┌──────────────────────────────────────────────────────┐
 │ COST REDUCTION, in order of leverage                  │
 │  1. prompt caching        70-90% off repeated prefix  │
 │  2. model routing         cheap model for easy work   │
 │  3. response caching      identical requests          │
 │  4. context management    stop resending history      │
 │  5. batch API             async, large discounts      │
 └───────────────┬──────────────────────────────────────┘
                 ▼
 ┌──────────────────────────────────────────────────────┐
 │ ATTRIBUTION: every dollar → trace → user → team       │
 │ ALERT on rate of change, not absolute spend           │
 └──────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Per-request budget | Bound a single request | Token counter in the loop | Step cap only — steps are not cost |
| Per-user quota | Bound one user's damage | Redis counter, daily window | Absent → one user drains the budget |
| Per-team budget | Attribution and accountability | Per-team keys + monthly cap | Shared key → no attribution |
| Rate limiter | Stay inside provider quotas | Distributed token buckets, both dimensions | Requests counted, tokens ignored |
| Queue | Absorb bursts | Bounded queue with a deadline | Unbounded → memory growth and huge latency |
| Cost calculator | Tokens → USD | Versioned price table | Not updated; historical cost wrong |
| Anomaly detection | Catch regressions early | Rate-of-change alerts | Alerting on absolute spend only |
| Batch path | Cheap async work | Provider batch API | Not used for offline jobs |

## 4. Data flow

1. Before any model call, check budgets in order: per-request → per-user → per-team. Reject early and cheaply.
2. Estimate the request's token cost; acquire from **both** the request and token buckets.
3. If refused, queue with a deadline; drop or degrade past it rather than queueing forever.
4. Apply cost reductions: caching, model routing, context management.
5. After the call, record actual tokens and cost against trace, user, and team.
6. Aggregate continuously; alert on **rate of change** (today vs the trailing week) rather than a monthly total, which arrives too late.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class Budget(BaseModel):
    per_request_usd: float = Field(0.50, description="Hard stop for one request.")
    per_user_daily_usd: float = 5.00
    per_team_monthly_usd: float = 1000.00
    action_on_exceed: str = "degrade"    # "degrade" | "reject" | "queue"

class RateLimits(BaseModel):
    """Providers cap BOTH. Limiting only requests is the classic mistake."""
    requests_per_minute: int
    tokens_per_minute: int
    max_concurrent: int = 8
    queue_max_wait_s: float = 30.0

class CostRecord(BaseModel):
    trace_id: str
    user_id: str | None
    team: str
    model: str
    input_tokens: int
    output_tokens: int
    cached_tokens: int = 0
    cost_usd: float
    price_table_version: str = Field(description="Prices change; historical cost must not.")
```

## 6. Reference implementation

```python
import asyncio, time

class TokenBucket:
    """Both dimensions need one of these. Distributed (Redis) if you run >1 instance."""
    def __init__(self, rate_per_min: int, burst: int | None = None):
        self.rate = rate_per_min / 60.0
        self.capacity = burst or rate_per_min
        self.tokens = float(self.capacity)
        self.updated = time.monotonic()
        self.lock = asyncio.Lock()

    async def acquire(self, n: int, max_wait_s: float) -> bool:
        deadline = time.monotonic() + max_wait_s
        while True:
            async with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= n:
                    self.tokens -= n
                    return True
                wait = (n - self.tokens) / self.rate
            if time.monotonic() + wait > deadline:
                return False                       # let the caller degrade, not hang
            await asyncio.sleep(min(wait, 1.0))

class BudgetedRunner:
    """Cost budgets belong INSIDE the agent loop. A step cap is not a cost cap:
    one step reading a 100k-token document can cost more than ten small steps."""
    def __init__(self, budget: Budget):
        self.budget, self.spent = budget, 0.0

    def check(self, estimated_usd: float) -> str:
        if self.spent + estimated_usd > self.budget.per_request_usd:
            return self.budget.action_on_exceed
        return "allow"

    def record(self, actual_usd: float):
        self.spent += actual_usd

async def call_with_limits(req, limiter_req: TokenBucket, limiter_tok: TokenBucket,
                           runner: BudgetedRunner, limits: RateLimits):
    est_tokens = estimate_tokens(req)
    est_cost = estimate_cost(req.model, est_tokens)

    action = runner.check(est_cost)
    if action == "reject":
        raise BudgetExceeded(f"Request budget ${runner.budget.per_request_usd} exhausted")
    if action == "degrade":
        req = downgrade(req)                       # smaller model, fewer chunks, shorter output
        est_tokens, est_cost = estimate_tokens(req), estimate_cost(req.model, est_tokens)

    # BOTH buckets must admit.
    ok = (await limiter_req.acquire(1, limits.queue_max_wait_s)
          and await limiter_tok.acquire(est_tokens, limits.queue_max_wait_s))
    if not ok:
        raise RateLimited("Could not acquire capacity within the wait budget")

    resp = await provider.call(req)
    actual = cost_of(resp.model, resp.usage)
    runner.record(actual)
    await costs.record(CostRecord(trace_id=req.trace_id, user_id=req.user_id,
                                  team=req.team, model=resp.model,
                                  input_tokens=resp.usage.input_tokens,
                                  output_tokens=resp.usage.output_tokens,
                                  cached_tokens=getattr(resp.usage, "cache_read_input_tokens", 0),
                                  cost_usd=actual, price_table_version=PRICE_VERSION))
    return resp
```

Anomaly detection that catches regressions in a day, not a month:

```python
async def check_cost_anomaly():
    today = await costs.sum(days=0)
    baseline = await costs.mean_daily(days_back=7, exclude_today=True)
    if baseline > 0 and today > baseline * 2:
        alert(f"Cost today ${today:.2f} is {today/baseline:.1f}× the 7-day mean "
              f"${baseline:.2f}. Top movers: {await costs.top_deltas(5)}")
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Per-request cap | $0.50 | Worst-case single request | Set from p99 of healthy runs, not the mean |
| Per-user daily | $5 | Blast radius of one user | Tighter for free tiers |
| Per-team monthly | budgeted | Accountability | Always set; alert at 80% |
| Action on exceed | degrade | UX vs cost | Degrade beats reject for user-facing paths |
| Queue max wait | 30 s | Latency vs throughput | Shorter for interactive use |
| Anomaly threshold | 2× the 7-day mean | Alert sensitivity | Tune to your traffic variance |
| Batch API | for offline work | Cost | Large discounts on anything not latency-sensitive |
| Price table | versioned | Historical accuracy | Version on every price change |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Bill triples, noticed weeks later | No rate-of-change alerting | Daily cost vs trailing mean | Anomaly alerts on the derivative |
| One user consumes the budget | No per-user quota | Cost by user, p99 | Daily per-user caps |
| 429s despite headroom | Limiting requests but not tokens | 429s vs request rate | Two buckets, both enforced |
| Rate limits hit with 3 replicas | Per-instance limiter | 429s scale with replica count | Distributed buckets in Redis |
| Retry storms amplify an outage | No jitter, unbounded retries | Error spikes with synchronised timing | Jittered capped backoff; circuit breaker |
| Costs unattributable | Shared key, no per-request cost | Flat cost-by-team chart | Cost on every trace; per-team keys |
| Agent spends $12 on one request | Step cap but no cost cap | Cost p99 | Cost budget inside the loop |
| Cache hit rate collapsed, cost doubled | Prefix mutated | Cache hit rate metric | See [prompt-caching](prompt-caching.md) |
| Queue grows without bound | No deadline | Memory and latency growth | Bounded queue + deadline + degrade |

## 9. Anti-patterns

- **Step caps as cost caps.** One step reading a huge document can outspend ten small steps. Budget in dollars.
- **Limiting requests but not tokens.** Providers cap both; you will hit the one you ignored.
- **Per-instance rate limiting.** Correct at one replica, broken at three.
- **Alerting on monthly spend.** The month is over by the time it fires.
- **No per-user quota.** One pathological user, or one loop, drains the shared budget.
- **Rejecting instead of degrading on user-facing paths.** A smaller model beats an error.
- **Unversioned price tables.** Historical cost analysis becomes wrong after every price change.
- **Not using the batch API for offline work.** Large discounts left unclaimed.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Cost per request | p50 / p99 USD | p99 < 5× p50 | p99 > 10× p50 |
| Daily cost vs 7-day mean | Ratio | < 1.3× | > 2× |
| Cost attribution | Spend mapped to a team | 100% | < 98% |
| 429 rate | Rate-limited / total | < 0.5% | > 3% |
| Queue wait p95 | Time in the limiter queue | < 2 s | > 10 s |
| Budget rejection rate | Requests refused on budget | < 1% | > 5% |
| Cache-driven saving | Cost avoided by caching | > 30% | < 10% |
| Batch share | Offline work using the batch API | > 80% of eligible | < 30% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Provider spend cap on the key |
| v1 | Cost is unattributable | Per-request cost recorded on every trace |
| v2 | One user or bug spikes spend | Per-request and per-user budgets |
| v3 | 429s reach users | Distributed two-dimension rate limiting with queueing |
| v4 | Cost grows faster than usage | Caching, model routing, context management |
| v5 | Multi-team | Per-team keys and budgets, chargeback, anomaly alerting |

## 12. Build checklist

- [ ] Cost budgets are in dollars and enforced inside agent loops, not just step caps.
- [ ] Per-user daily and per-team monthly quotas exist.
- [ ] Rate limiting enforces both requests/min and tokens/min.
- [ ] Rate limiters are distributed if more than one instance runs.
- [ ] Queues are bounded and have a deadline; exceeding it degrades.
- [ ] Degrade (smaller model, less context) is preferred over reject on user-facing paths.
- [ ] Every request records actual cost against trace, user, and team.
- [ ] The price table is versioned and stamped on every cost record.
- [ ] Alerts fire on rate of change, not monthly totals.
- [ ] Prompt caching hit rate is monitored — it is the largest single lever.
- [ ] Offline work uses the batch API.

## 13. Related

- [gateway-and-routing.md](gateway-and-routing.md) — where these controls live
- [observability-tracing.md](observability-tracing.md) — the attribution source
- [prompt-caching.md](prompt-caching.md) — the biggest cost lever
- [context-engineering.md](context-engineering.md) — cutting tokens at the source
