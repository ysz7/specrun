+++
id = "embedding-pipeline"
title = "Embedding pipeline"
use_when = "Embedding text at scale: batching, rate limits, caching, retries, and the migration path for the day the embedding model changes"
pack = "data pipelines"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Embedding Pipeline

> Turning text into vectors at scale — batching, rate limits, caching, retries, and the migration path for the day you change embedding models.

**Tier:** intermediate
**Use when:** embedding more than a few thousand chunks, or embedding continuously.
**Avoid when:** a one-off batch of a few hundred. A loop is fine.
**Cost profile:** usually the largest line item in an ingestion pipeline. Caching by content hash typically removes 80–95% of it on steady state.

---

## 1. Problem it solves

Embedding is the stage where naive code becomes expensive. A loop calling the API once per chunk is 50–100× slower than batching and hits rate limits immediately. Without content-hash caching, every pipeline run re-pays for unchanged text. Without a retry policy, one 429 loses a batch.

And the decision nobody plans for: **changing the embedding model requires re-embedding the entire corpus**, and the old and new vectors are not comparable, so it cannot be done gradually without a dual-index strategy. Deciding that upfront costs an hour; discovering it later costs a weekend of downtime.

## 2. Shape

```
   chunks
     │
     ▼
 ┌────────────────┐   hit    ┌──────────────────────┐
 │ cache lookup   │─────────▶│ cached vectors       │
 │ by content hash│          │ (80-95% on steady    │
 └───────┬────────┘          │  state)              │
         │ miss              └──────────────────────┘
         ▼
 ┌────────────────┐
 │ batcher        │  group by token budget, not by count
 │ 96-2048 texts  │
 └───────┬────────┘
         ▼
 ┌────────────────┐   429/5xx   ┌─────────────────────┐
 │ API call       │────────────▶│ backoff + jitter    │
 │ (bounded       │◀────────────│ ≤5 attempts         │
 │  concurrency)  │             └─────────────────────┘
 └───────┬────────┘
         ▼
 ┌────────────────┐
 │ write vectors  │──▶ store, keyed by chunk id, tagged with model+dimension
 │ + cache        │
 └────────────────┘

 MODEL CHANGE:  new model → new index → dual-write → verify → cut over → drop old
                (vectors from different models are NOT comparable)
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Cache | Skip unchanged text | KV store keyed by `hash(model, text)` | Keyed on text only → wrong vectors after a model change |
| Batcher | Group by token budget | Custom | Groups by count, so long texts overflow the request |
| Rate limiter | Stay inside quota | Semaphore + token-bucket | Only counts requests, not tokens |
| Retry policy | Survive transient failures | Exponential backoff + jitter | No jitter → synchronised retry storms |
| Truncation guard | Respect the model's input limit | Tokenizer check | Silent truncation loses the tail |
| Model registry | Which model produced which vectors | Metadata on every record | Absent → mixed vectors, silently broken search |
| Dual-writer | Migration path | Two indexes during cutover | Absent → downtime for any model change |
| Cost accounting | Track spend | Token counters | Discovered on the invoice |

## 4. Data flow

1. Compute `cache_key = sha256(model_id + normalised_text)`. **The model id must be in the key** — the same text under a different model is a different vector.
2. Look up cached vectors; only misses proceed.
3. Verify each text is within the model's token limit; truncate explicitly and record a warning, or split.
4. Batch by **token budget**, not item count — a batch of 100 short strings and a batch of 100 long ones are very different requests.
5. Call the API with bounded concurrency, respecting both request-per-minute and token-per-minute limits.
6. On 429 or 5xx: exponential backoff with jitter, up to a cap. Non-retryable errors (400s) go straight to dead-letter.
7. Write vectors to the store tagged with `model_id` and `dimensions`; write to the cache.
8. Reconcile: every chunk must have exactly one vector for the active model.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class EmbeddingConfig(BaseModel):
    model_id: str
    dimensions: int
    max_input_tokens: int = Field(description="Per text. Exceeding it truncates silently.")
    max_batch_texts: int = 96
    max_batch_tokens: int = Field(100_000, description="Batch by THIS, not by count.")
    concurrency: int = 4
    max_retries: int = 5
    requests_per_minute: int | None = None
    tokens_per_minute: int | None = None

class EmbeddingRecord(BaseModel):
    chunk_id: str
    vector: list[float]
    model_id: str = Field(description="Vectors from different models are not comparable.")
    dimensions: int
    content_hash: str
    embedded_at: float
    truncated: bool = False

class MigrationState(BaseModel):
    from_model: str
    to_model: str
    stage: str            # "dual_write" | "backfilling" | "verifying" | "cutover" | "cleanup"
    progress: float
    old_index: str
    new_index: str
```

## 6. Reference implementation

```python
import asyncio, hashlib, random, logging

def cache_key(model_id: str, text: str) -> str:
    """model_id in the key. Same text + different model = different vector."""
    return hashlib.sha256(f"{model_id}\x00{text}".encode()).hexdigest()

def batch_by_tokens(texts: list[str], cfg: EmbeddingConfig, count_tokens):
    """Batching by count overflows on long texts and wastes quota on short ones."""
    batch, batch_tokens = [], 0
    for t in texts:
        n = count_tokens(t)
        if n > cfg.max_input_tokens:
            logging.warning("text exceeds %d tokens; truncating", cfg.max_input_tokens)
            t, n = truncate_tokens(t, cfg.max_input_tokens), cfg.max_input_tokens
        if batch and (len(batch) >= cfg.max_batch_texts
                      or batch_tokens + n > cfg.max_batch_tokens):
            yield batch
            batch, batch_tokens = [], 0
        batch.append(t)
        batch_tokens += n
    if batch:
        yield batch

async def embed_with_retry(client, batch: list[str], cfg: EmbeddingConfig):
    for attempt in range(cfg.max_retries):
        try:
            return await client.embed(model=cfg.model_id, texts=batch)
        except RateLimitError as e:
            # Jitter is not optional: without it, every worker retries in lockstep.
            delay = min(2 ** attempt, 60) * (0.5 + random.random())
            logging.warning("rate limited, sleeping %.1fs (attempt %d)", delay, attempt + 1)
            await asyncio.sleep(delay)
        except (BadRequestError, ValidationError):
            raise                                     # not retryable — dead-letter it
    raise RuntimeError(f"embedding failed after {cfg.max_retries} attempts")

async def embed_chunks(chunks, client, cache, store, cfg: EmbeddingConfig, count_tokens):
    keys = {c.id: cache_key(cfg.model_id, c.text) for c in chunks}
    cached = await cache.get_many(list(keys.values()))

    hits = [c for c in chunks if keys[c.id] in cached]
    misses = [c for c in chunks if keys[c.id] not in cached]
    logging.info("embedding cache: %d hits / %d misses", len(hits), len(misses))

    await store.upsert_vectors([
        EmbeddingRecord(chunk_id=c.id, vector=cached[keys[c.id]], model_id=cfg.model_id,
                        dimensions=cfg.dimensions, content_hash=c.content_hash,
                        embedded_at=time.time())
        for c in hits])

    sem = asyncio.Semaphore(cfg.concurrency)
    by_text = {c.text: c for c in misses}

    async def run(batch: list[str]):
        async with sem:
            vectors = await embed_with_retry(client, batch, cfg)
            records, to_cache = [], {}
            for text, vec in zip(batch, vectors):
                c = by_text[text]
                records.append(EmbeddingRecord(
                    chunk_id=c.id, vector=vec, model_id=cfg.model_id,
                    dimensions=cfg.dimensions, content_hash=c.content_hash,
                    embedded_at=time.time()))
                to_cache[cache_key(cfg.model_id, text)] = vec
            await store.upsert_vectors(records)
            await cache.set_many(to_cache)

    await asyncio.gather(*[run(b) for b in
                           batch_by_tokens([c.text for c in misses], cfg, count_tokens)])
```

Model migration — plan it before you need it:

```python
async def migrate_model(old: EmbeddingConfig, new: EmbeddingConfig, store, corpus):
    """Vectors from different models share no space. There is no gradual mixing —
    you build a second index and cut over."""
    new_index = await store.create_index(name=f"chunks_{new.model_id}",
                                         dimensions=new.dimensions)
    # 1. Dual-write: new content goes to both indexes from now on.
    await store.enable_dual_write(old_index="chunks", new_index=new_index.name)
    # 2. Backfill the existing corpus into the new index.
    async for batch in corpus.iter_chunks(batch_size=500):
        await embed_chunks(batch, client, cache, new_index, new, count_tokens)
    # 3. Verify on the SAME eval set before cutting over. Never assume newer is better.
    metrics_old = await run_retrieval_eval(index="chunks")
    metrics_new = await run_retrieval_eval(index=new_index.name)
    if metrics_new["recall@20"] < metrics_old["recall@20"] - 0.02:
        raise SystemExit(f"New model regresses recall: {metrics_old} → {metrics_new}")
    # 4. Cut over reads, then stop dual-writing, then drop the old index.
    await store.switch_read_index(new_index.name)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `max_batch_tokens` | 100k | Request efficiency | Match the provider's per-request limit |
| `max_batch_texts` | 96 | Provider limit | Follow the API docs |
| `concurrency` | 4 | Throughput vs rate limits | Raise until you see 429s, then back off |
| `max_retries` | 5 | Transient tolerance | Backoff must be capped at ~60 s |
| Cache TTL | none | Cost | Vectors do not expire; keep them |
| Truncation | explicit + warn | Silent data loss | Split long texts instead where possible |
| Model change | dual-index migration | Availability | Never in place |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Embedding cost 10× expected | No cache, or cache keyed on text only | Cache hit rate | Key on `model_id + text` |
| Constant 429s | Concurrency above quota; no jitter | Rate-limit error rate | Bounded concurrency + jittered backoff |
| Batches rejected as too large | Batching by count, not tokens | 400s on long-text batches | Batch by token budget |
| Search quality degraded silently | Mixed model vectors in one index | `model_id` distribution in the store | Tag every vector; assert one model per index |
| Long documents retrieve poorly | Silent truncation at the input limit | `truncated` flag rate | Split before embedding; warn on truncation |
| Migration caused downtime | In-place re-embedding | Search errors during migration | Dual index + verified cutover |
| New model is worse | Assumed newer means better | Retrieval eval before cutover | Always evaluate before switching |
| Retry storms | No jitter | Synchronised error spikes | Full jitter on backoff |

## 9. Anti-patterns

- **One API call per chunk.** 50–100× slower and immediately rate-limited.
- **Cache keyed on text alone.** After a model change you serve vectors from the wrong space.
- **Batching by item count.** Long texts overflow the request; short ones waste the batch.
- **Retrying without jitter.** Every worker retries at the same instant, forever.
- **In-place model migration.** There is no gradual path; build a second index.
- **Switching models without an eval.** Newer is not automatically better on *your* corpus.
- **Ignoring the input token limit.** Silent truncation destroys the end of every long chunk.
- **Untagged vectors.** You cannot tell which model produced what, so you cannot migrate safely.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Cache hit rate | Cached / total on steady state | > 90% | < 60% |
| Rate-limit error rate | 429s / requests | < 1% | > 5% |
| Throughput | Chunks embedded per minute | Baseline-dependent | < 50% of baseline |
| Truncation rate | Texts truncated at the limit | < 0.5% | > 2% |
| Cost per 1M tokens | USD | Provider baseline | > 1.5× expected |
| Model consistency | Distinct `model_id` values per index | 1 | > 1 |
| Vector coverage | Chunks with a vector for the active model | 100% | < 99.9% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Loop, one call per chunk |
| v1 | Slow or rate-limited | Token-budget batching + bounded concurrency |
| v2 | Cost hurts | Content-hash cache keyed on `model_id + text` |
| v3 | Transient failures lose work | Jittered backoff + dead-letter for non-retryables |
| v4 | Model change needed | Dual-index migration with an eval gate |
| v5 | Very large corpora | Self-hosted embedding models, GPU batching, quantised storage |

## 12. Build checklist

- [ ] Cache key includes the model id.
- [ ] Batching is by token budget, not item count.
- [ ] Concurrency is bounded and sized to the provider quota.
- [ ] Retries use exponential backoff **with jitter**, capped.
- [ ] Non-retryable errors go to dead-letter immediately.
- [ ] Input token limits are checked; truncation is explicit and recorded.
- [ ] Every vector is tagged with `model_id` and `dimensions`.
- [ ] An assertion enforces one model per index.
- [ ] A dual-index migration path exists and has been rehearsed.
- [ ] A retrieval eval gates any model change.
- [ ] Cache hit rate and cost per run are monitored.

## 13. Related

- [ingestion-pipeline.md](ingestion-pipeline.md) — the surrounding pipeline
- [vector-store-selection.md](vector-store-selection.md) — where vectors land
- [rag-evaluation.md](rag-evaluation.md) — the gate for a model change
- [cost-and-rate-limits.md](cost-and-rate-limits.md) — quota management
