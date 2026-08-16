+++
id = "prompt-caching"
title = "Prompt caching"
use_when = "The same prefix goes out on every call and should be billed once; or caching is configured and the hit rate is near zero"
pack = "prompting"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Prompt Caching

> Reusing the provider's computed state for a prompt prefix across calls, so repeated context is billed and processed at a fraction of the normal cost.

**Tier:** foundational
**Use when:** the same prefix (system prompt, tool schemas, a document, few-shot examples) is sent more than once within the cache window.
**Avoid when:** every call is genuinely unique and short. Cache writes carry a premium, so caching a prefix used once costs more than not caching it.
**Cost profile:** typically ~90% discount on cached input tokens, with a write premium on the first call. Break-even is usually two reads.

---

## 1. Problem it solves

Agent loops and RAG systems re-send enormous prefixes. A 20-step agent run sends the same system prompt and tool schemas 20 times; a document-QA system sends the same 50k-token document for every question. Without caching you pay full price and full latency for identical computation, every time.

Caching is close to free money — with one hard constraint that catches almost everyone: **the cached prefix must be byte-identical.** One timestamp, one reordered tool, one request id in the system block, and the hit rate is zero. Most "caching doesn't work for us" reports are a mutating prefix.

## 2. Shape

```
call 1                                   call 2 (within TTL)
┌────────────────────────────┐           ┌────────────────────────────┐
│ system prompt              │           │ system prompt              │  ← identical bytes
│ tool schemas               │  WRITE    │ tool schemas               │  ← CACHE HIT
│ few-shot examples          │  (premium)│ few-shot examples          │     ~90% cheaper
│ ▸ cache breakpoint         │           │ ▸ cache breakpoint         │
├────────────────────────────┤           ├────────────────────────────┤
│ retrieved document         │  WRITE    │ retrieved document         │  ← HIT if same doc
│ ▸ cache breakpoint         │           │ ▸ cache breakpoint         │
├────────────────────────────┤           ├────────────────────────────┤
│ turn 1                     │  full     │ turn 1                     │
│                            │  price    │ turn 2  ← new, full price  │
└────────────────────────────┘           └────────────────────────────┘

   Prefix matching is LINEAR from the start. A change at position 100
   invalidates everything after it, regardless of breakpoints.
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Stable prefix | The content being cached | System, tools, examples, documents | Contains a timestamp or request id |
| Cache breakpoint | Marks where a cacheable segment ends | Provider-specific marker; limited count | Placed before volatile content |
| TTL | How long the entry survives | Commonly ~5 min, with longer options | Assumed longer than it is |
| Serialisation order | Byte-stability of the prefix | Deterministic tool ordering, stable JSON key order | Dict iteration order varies between runs |
| Metrics | Cache read/write token counts | In the usage response | Not monitored, so breakage is invisible |
| Warmer | Optional call to populate the cache | For latency-sensitive first requests | Adds cost without measurement |

## 4. Data flow

1. Assemble the prefix deterministically: fixed tool order, stable JSON key ordering, no volatile values.
2. Place breakpoints at the end of each stable segment, ordered most-stable → least-stable.
3. First call: provider computes and stores the prefix state; those tokens are billed at a write premium.
4. Subsequent calls with a byte-identical prefix: cached portion is billed at a large discount and skips recomputation.
5. Any byte difference at position *n* invalidates everything from *n* onward.
6. Monitor `cache_read_input_tokens` vs `cache_creation_input_tokens` vs `input_tokens` on every call.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class CacheSegments(BaseModel):
    """Ordered most-stable first. Anything volatile must be below all breakpoints."""
    system: str                       # never contains time, ids, or user names
    tools: list[dict]                 # ALWAYS in the same order — sort by name
    examples: list[dict] = []
    documents: list[str] = []         # cache per document when reused across questions
    # everything below is uncached:
    history: list[dict] = []
    current_turn: str = ""

class CacheUsage(BaseModel):
    input_tokens: int                 # uncached, full price
    cache_creation_input_tokens: int  # write, premium
    cache_read_input_tokens: int      # hit, ~90% discount

    @property
    def hit_rate(self) -> float:
        total = self.input_tokens + self.cache_creation_input_tokens + self.cache_read_input_tokens
        return self.cache_read_input_tokens / total if total else 0.0
```

## 6. Reference implementation

```python
from anthropic import Anthropic
client = Anthropic()

def build_request(system: str, tools: list[dict], document: str | None,
                  messages: list[dict]) -> dict:
    # Breakpoint 1: system prompt (most stable)
    system_blocks = [{"type": "text", "text": system,
                      "cache_control": {"type": "ephemeral"}}]

    # Tools MUST be in a deterministic order or the prefix changes between runs.
    tools_sorted = sorted(tools, key=lambda t: t["name"])
    if tools_sorted:
        # Breakpoint 2: end of the tool block
        tools_sorted[-1] = {**tools_sorted[-1], "cache_control": {"type": "ephemeral"}}

    msgs = list(messages)
    if document:
        # Breakpoint 3: the document — reused across every question about it
        msgs.insert(0, {"role": "user", "content": [
            {"type": "text", "text": f"<document>\n{document}\n</document>",
             "cache_control": {"type": "ephemeral"}}]})

    return {"model": "<MODEL_ID>", "max_tokens": 4096,
            "system": system_blocks, "tools": tools_sorted, "messages": msgs}

def call_and_report(**kwargs):
    resp = client.messages.create(**kwargs)
    u = resp.usage
    usage = CacheUsage(input_tokens=u.input_tokens,
                       cache_creation_input_tokens=getattr(u, "cache_creation_input_tokens", 0),
                       cache_read_input_tokens=getattr(u, "cache_read_input_tokens", 0))
    metrics.gauge("llm.cache_hit_rate", usage.hit_rate)
    if usage.hit_rate < 0.4 and usage.input_tokens > 2000:
        logging.warning("Low cache hit rate (%.2f) — check the prefix for volatile content",
                        usage.hit_rate)
    return resp, usage
```

The bug that causes most cache failures:

```python
# ✗ Destroys caching completely — the prefix changes every single call
SYSTEM = f"You are an assistant. Current time: {datetime.now()}. User: {user.name}"

# ✓ Stable prefix; volatile facts move to the last user turn
SYSTEM = "You are an assistant. Time and user identity are provided in the request."
messages.append({"role": "user", "content":
                 f"<context>time: {now} · user: {user.name}</context>\n\n{question}"})
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Breakpoint placement | end of each stable segment | What gets cached | Order most-stable → least-stable |
| Number of breakpoints | provider-limited (often ~4) | Granularity | Spend them on the largest stable blocks |
| TTL | provider default (~5 min) | Hit rate for sparse traffic | Use a longer TTL option if available and traffic is bursty |
| Minimum cacheable size | provider-specific | Whether caching applies at all | Small prefixes may not be cacheable |
| Tool ordering | sorted by name | Byte-stability | Always deterministic |
| JSON key ordering | sorted | Byte-stability | `json.dumps(..., sort_keys=True)` |
| Cache warming | off | First-request latency | On only for latency-critical paths, measured |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Hit rate ~0 | Timestamp/id/user name in the system block | Cache metrics per call | Move all volatile facts to the last user turn |
| Hit rate varies run to run | Non-deterministic tool or key ordering | Diff serialised prefixes across runs | Sort tools by name; `sort_keys=True` |
| Hit rate drops after a deploy | Prompt text changed | Hit rate over time, correlated with releases | Expected — it recovers; alert only on sustained drops |
| Cost went **up** after enabling caching | Prefix used once per session | Write vs read token ratio | Cache only prefixes reused ≥ 2× |
| Cache misses on long-running sessions | TTL expired between turns | Time between calls vs TTL | Longer TTL, or accept the miss |
| Document cached per question but never hits | Document text reassembled differently each time | Compare document bytes | Serialise once and reuse the exact string |
| Only the first breakpoint hits | A later segment mutates | Per-segment analysis | Reorder segments by stability |

## 9. Anti-patterns

- **Interpolating the current time into the system prompt.** The single most common cause of 0% hit rates.
- **Passing tools in dict-iteration order.** Silently unstable across processes.
- **Caching a prefix used once.** The write premium makes it a net loss.
- **Not monitoring hit rate.** Caching breaks silently; nothing errors, the bill just rises.
- **Breakpoints before volatile content.** Everything after the mutation is invalidated anyway.
- **Assuming a long TTL.** Sparse traffic often misses entirely; measure rather than assume.
- **Rebuilding a document string per call.** Different whitespace or ordering means different bytes.
- **Cache warming without measurement.** Extra cost, unproven benefit.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Cache hit rate | read tokens / total input tokens | > 70% | < 40% |
| Write/read ratio | creation / read tokens | < 0.2 | > 0.5 (caching may be a loss) |
| Cost per request | USD, blended | ↓ vs pre-cache baseline | above baseline |
| TTFT improvement | Time to first token, cached vs not | ≥ 30% faster | no improvement |
| Prefix stability | Distinct prefix hashes per session | 1 | > 1 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | No caching |
| v1 | Repeated system prompt or tools | One breakpoint after tools; monitor hit rate |
| v2 | Hit rate below target | Audit the prefix for volatile content; enforce deterministic ordering |
| v3 | Documents reused across questions | Per-document breakpoint |
| v4 | Long agent runs | Breakpoints layered by stability; hit rate alerting |
| v5 | Sparse but bursty traffic | Longer-TTL options; measured warming on latency-critical paths |

## 12. Build checklist

- [ ] No timestamps, request ids, user names, or random values in the cached prefix.
- [ ] Tools are serialised in a deterministic order (sorted by name).
- [ ] JSON serialisation uses stable key ordering.
- [ ] Breakpoints are placed at segment ends, ordered most-stable → least-stable.
- [ ] Documents reused across calls are serialised once and reused byte-for-byte.
- [ ] `cache_read` / `cache_creation` / `input` tokens are recorded on every call.
- [ ] Cache hit rate is a monitored metric with an alert below 40%.
- [ ] Caching is only enabled for prefixes reused at least twice.
- [ ] Cost per request is compared against the pre-cache baseline.

## 13. Related

- [prompt-structure.md](prompt-structure.md) — the layout that makes caching possible
- [context-engineering.md](context-engineering.md) — why the agent loop depends on this
- [contextual-retrieval.md](contextual-retrieval.md) — caching a document across its chunks
- [cost-and-rate-limits.md](cost-and-rate-limits.md) — the wider cost picture
