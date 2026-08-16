+++
id = "ingestion-pipeline"
title = "Ingestion pipeline"
use_when = "Documents or records have to be loaded continuously into an index or store, with idempotency, incremental runs, and one bad document not stopping the batch"
pack = "data pipelines"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Ingestion Pipeline

> The path from a source system to an indexed, queryable representation — with idempotency, incremental processing, and failure isolation so a bad document does not stop the batch.

**Tier:** foundational
**Use when:** documents or records must be continuously loaded into an index, warehouse, or vector store.
**Avoid when:** a one-off load of a static corpus. A script is fine; do not build a pipeline for it.
**Cost profile:** dominated by parsing and embedding. Idempotency and content hashing typically cut re-processing cost by 90%+.

---

## 1. Problem it solves

The naive loader — read everything, process everything, write everything — breaks in four predictable ways as the corpus grows: it re-embeds unchanged documents (cost), it stops entirely on one malformed file (availability), it leaves partial state when it crashes (correctness), and deleted source documents linger in the index forever (staleness).

Each has a standard fix, and together they are the difference between a script and a pipeline: **content-addressed idempotency, per-document failure isolation, atomic stage transitions, and tombstoned deletes.**

## 2. Shape

```
  SOURCE            EXTRACT         TRANSFORM              LOAD              INDEX
 ┌────────┐       ┌──────────┐    ┌──────────────┐    ┌───────────┐    ┌───────────┐
 │ S3     │       │ fetch    │    │ parse        │    │ upsert by │    │ vector +  │
 │ DB     │──────▶│ + hash   │───▶│ chunk        │───▶│ stable id │───▶│ lexical   │
 │ API    │       │          │    │ enrich       │    │ tombstone │    │           │
 │ Drive  │       │ skip if  │    │ embed        │    │ deletes   │    │           │
 └────────┘       │ unchanged│    └──────┬───────┘    └───────────┘    └───────────┘
                  └──────────┘           │
                        │                │ per-document failure
                        ▼                ▼
                 ┌──────────────────────────────────┐
                 │ STATE TABLE                      │  source_id → content_hash,
                 │ status, attempts, last_error     │  stage, updated_at
                 └──────────────┬───────────────────┘
                                ▼
                        ┌───────────────┐
                        │ dead letter   │  N failures → quarantine, alert, continue
                        └───────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Source connector | Enumerate and fetch | S3, DB cursor, API client | No pagination → misses records |
| Content hasher | Detect real changes | sha256 of normalised bytes | Hashing metadata that changes every fetch |
| State table | What has been processed, at which version | Postgres, DynamoDB | Kept in memory → lost on restart |
| Parser | Bytes → structured text | See [document-parsing.md](document-parsing.md) | Crashes the batch on one bad file |
| Transformer | Chunk, enrich, embed | Pipeline code | Non-deterministic → unstable ids |
| Loader | Idempotent upsert | Store client | Insert-only → duplicates on retry |
| Tombstoner | Propagate deletes | Delete-by-source-id | Absent → deleted docs stay searchable |
| Dead-letter queue | Isolate poison documents | Table or queue | Absent → one file blocks everything |
| Orchestrator | Schedule, retry, backfill | Airflow, Dagster, Temporal, cron | No backfill path |

## 4. Data flow

1. **Enumerate** source records with a cursor or watermark; never load the full list into memory.
2. **Fetch** and compute a content hash over the *normalised* content — excluding volatile metadata like `last_accessed`.
3. **Skip** if the hash matches the state table. This is the single largest cost saving in the pipeline.
4. **Parse** inside a per-document try/except. Failures go to dead-letter with the error and attempt count; the batch continues.
5. **Transform** deterministically: the same input must always yield the same chunk ids.
6. **Load** with idempotent upserts keyed on the stable id.
7. **Reconcile deletes:** any id present in the index but absent from the source enumeration is tombstoned.
8. **Record** the new hash and status atomically with the load, or the pipeline lies about its own state.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime

Stage = Literal["discovered", "fetched", "parsed", "transformed", "loaded", "failed", "deleted"]

class SourceRecord(BaseModel):
    source_id: str = Field(description="Stable in the SOURCE system. Never a row number.")
    uri: str
    content_hash: str = Field(description="sha256 of normalised content only.")
    source_updated_at: datetime
    metadata: dict = Field(default_factory=dict)

class PipelineState(BaseModel):
    source_id: str
    content_hash: str
    stage: Stage
    attempts: int = 0
    last_error: str | None = None
    updated_at: datetime
    output_ids: list[str] = Field(default_factory=list,
                                  description="Chunk ids produced — needed to clean up on re-process.")

class IngestConfig(BaseModel):
    batch_size: int = 100
    max_attempts: int = 3
    concurrency: int = 8
    dead_letter_after: int = 3
    delete_reconciliation: bool = True
    dry_run: bool = False
```

## 6. Reference implementation

```python
import asyncio, hashlib, logging
from datetime import datetime, UTC

def content_hash(content: bytes, metadata: dict) -> str:
    """Hash only what MATTERS. Including last_accessed or an ETag that rotates
    means every document looks changed on every run."""
    stable = {k: v for k, v in metadata.items()
              if k in {"title", "author", "source_updated_at", "mime_type"}}
    h = hashlib.sha256(content)
    h.update(repr(sorted(stable.items())).encode())
    return h.hexdigest()

async def ingest(source, store, state_db, cfg: IngestConfig) -> dict:
    sem = asyncio.Semaphore(cfg.concurrency)
    stats = {"skipped": 0, "processed": 0, "failed": 0, "deleted": 0}
    seen_ids: set[str] = set()

    async def one(rec: SourceRecord):
        async with sem:
            seen_ids.add(rec.source_id)
            prior = await state_db.get(rec.source_id)

            # The cost saving: unchanged content is never re-parsed or re-embedded.
            if prior and prior.content_hash == rec.content_hash and prior.stage == "loaded":
                stats["skipped"] += 1
                return

            if prior and prior.attempts >= cfg.dead_letter_after:
                logging.warning("dead-lettered, skipping: %s", rec.source_id)
                return

            try:
                content = await source.fetch(rec.uri)
                doc = parse(content, rec.metadata)          # may raise
                chunks = transform(doc, rec)                # deterministic ids
                if not cfg.dry_run:
                    await store.upsert(chunks)
                    # Remove chunks this document produced last time but no longer does.
                    if prior and prior.output_ids:
                        stale = set(prior.output_ids) - {c.id for c in chunks}
                        if stale:
                            await store.delete(list(stale))
                    # State written WITH the load — never before it.
                    await state_db.put(PipelineState(
                        source_id=rec.source_id, content_hash=rec.content_hash,
                        stage="loaded", attempts=0, updated_at=datetime.now(UTC),
                        output_ids=[c.id for c in chunks]))
                stats["processed"] += 1
            except Exception as e:
                # Per-document isolation: one poison file must not stop the batch.
                await state_db.put(PipelineState(
                    source_id=rec.source_id, content_hash=rec.content_hash,
                    stage="failed", attempts=(prior.attempts + 1 if prior else 1),
                    last_error=f"{type(e).__name__}: {e}", updated_at=datetime.now(UTC),
                    output_ids=prior.output_ids if prior else []))
                stats["failed"] += 1
                logging.exception("ingest failed for %s", rec.source_id)

    async for batch in source.enumerate(batch_size=cfg.batch_size):   # cursor-based
        await asyncio.gather(*[one(r) for r in batch])

    # Deletes: anything indexed but no longer in the source.
    if cfg.delete_reconciliation and not cfg.dry_run:
        for orphan in await state_db.ids_not_in(seen_ids):
            await store.delete_where(source_id=orphan)
            await state_db.mark_deleted(orphan)
            stats["deleted"] += 1

    return stats
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `batch_size` | 100 | Memory and checkpoint granularity | Smaller for large documents |
| `concurrency` | 8 | Throughput vs source and API limits | Match the tightest downstream quota |
| `max_attempts` | 3 | Transient-failure tolerance | Higher for flaky sources |
| `dead_letter_after` | 3 | When to quarantine | Poison documents never succeed; quarantine early |
| Delete reconciliation | on | Index freshness | Expensive on huge corpora — run it daily, not hourly |
| Hash scope | content + stable metadata | Skip rate | Exclude anything volatile |
| `dry_run` | off | Safe validation | On for every first run against a new source |
| Schedule | incremental hourly, full daily | Freshness vs cost | Match the source's real change rate |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Everything reprocesses every run | Hash includes volatile metadata | Skip rate near 0 | Hash content + stable fields only |
| One bad file stops the batch | No per-document isolation | Batch ends early | try/except per document + dead-letter |
| Duplicates after a retry | Insert instead of upsert; unstable ids | Row count exceeds source count | Content-addressed ids + upsert |
| Deleted documents still searchable | No delete reconciliation | Index count > source count | Reconcile against the enumeration |
| Partial state after a crash | State written before the load | Records marked loaded but absent | Write state with the load, atomically |
| Old chunks linger after an edit | Previous outputs not cleaned up | Chunk count grows monotonically | Track `output_ids`; delete the difference |
| Pipeline slows as the corpus grows | Full re-enumeration each run | Runtime vs corpus size | Watermark or CDC — see [incremental-sync-cdc.md](incremental-sync-cdc.md) |
| Silent data loss | Source pagination bug | Source count vs indexed count | Reconcile counts every run and alert on drift |

## 9. Anti-patterns

- **Reprocessing everything on every run.** Content hashing eliminates it and is twenty lines.
- **One try/except around the whole batch.** One malformed PDF blocks the corpus.
- **Row numbers or list positions as ids.** They shift, and every shift creates duplicates.
- **State updated before the write succeeds.** The pipeline then lies about what is loaded.
- **No delete path.** The index diverges from the source permanently and nobody notices.
- **Loading the full source list into memory.** Works at 10k documents, dies at 10M.
- **No dry-run mode.** The first run against a new source becomes the test.
- **No dead-letter queue.** Poison documents retry forever, consuming the whole budget.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Skip rate | Unchanged documents skipped | > 90% on steady state | < 50% |
| Freshness | Source change → searchable | < 1 h | > 6 h |
| Failure rate | Documents failing per run | < 1% | > 5% |
| Dead-letter size | Quarantined documents | < 0.1% of corpus | > 1% |
| Index/source parity | Indexed count vs source count | ±0.1% | > 1% drift |
| Throughput | Documents per minute | Baseline-dependent | < 50% of baseline |
| Cost per 1k documents | USD | Budgeted | > 2× baseline |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Script: load everything each run |
| v1 | Reprocessing cost hurts | Content hashing + state table |
| v2 | One bad file blocks runs | Per-document isolation + dead-letter queue |
| v3 | Index diverges from source | Delete reconciliation + parity monitoring |
| v4 | Full enumeration too slow | Watermarks or [CDC](incremental-sync-cdc.md) |
| v5 | Multiple sources, dependencies | Orchestrator (Dagster/Airflow/Temporal) with lineage and backfill |

## 12. Build checklist

- [ ] Source ids are stable in the source system, never positional.
- [ ] Content hash covers content plus stable metadata only.
- [ ] Unchanged documents are skipped before any parsing or embedding.
- [ ] Every document is processed inside its own try/except.
- [ ] Failures record the error and an attempt count; poison documents are dead-lettered.
- [ ] Transformations are deterministic — the same input yields the same chunk ids.
- [ ] Loads are idempotent upserts.
- [ ] Previous outputs no longer produced are deleted.
- [ ] State is written atomically with the load, never before.
- [ ] Deletes reconcile against the source enumeration.
- [ ] Enumeration is cursor-based, never a full in-memory list.
- [ ] A dry-run mode exists and is used against new sources.
- [ ] Index-to-source parity is monitored with an alert.

## 13. Related

- [document-parsing.md](document-parsing.md) — the stage that fails most often
- [incremental-sync-cdc.md](incremental-sync-cdc.md) — avoiding full enumeration
- [embedding-pipeline.md](embedding-pipeline.md) — the expensive downstream stage
- [rag-baseline.md](rag-baseline.md) — what consumes the output
