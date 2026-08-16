+++
id = "incremental-sync-cdc"
title = "Incremental sync and CDC"
use_when = "Keeping a derived index current by processing only what changed; a full re-run is too slow or too costly, or the index has drifted from its source"
pack = "data pipelines"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Incremental Sync and CDC

> Keeping a derived index current by processing only what changed — via watermarks, change feeds, or change-data-capture — instead of re-enumerating the whole source.

**Tier:** intermediate
**Use when:** full enumeration takes too long or costs too much, or freshness requirements are tighter than a full run's duration.
**Avoid when:** the corpus is small enough to fully re-enumerate within the freshness budget. Full sync is simpler and self-healing; do not give that up early.
**Cost profile:** cuts per-run cost proportionally to the change rate. Adds a state machine and a whole class of correctness bugs — the trade is real.

---

## 1. Problem it solves

Full enumeration is O(corpus). At 10k documents it takes minutes; at 10M it takes hours, and hourly freshness becomes impossible. Worse, most of that work is wasted — typically under 1% of documents change between runs.

Incremental sync makes the run O(changes). The cost is correctness: you now depend on the source correctly reporting what changed, and sources are unreliable narrators. Clocks skew, soft deletes are invisible, bulk updates touch every row, and connectors miss events during failover.

**The load-bearing rule: every incremental pipeline needs a periodic full reconciliation.** Incremental sync drifts; reconciliation is what makes the drift bounded and detectable.

## 2. Shape

```
  WATERMARK (simplest)              CHANGE FEED               CDC (log-based)
                                                          
  SELECT * FROM docs                source-native            WAL / binlog
  WHERE updated_at > :wm            change list              ──▶ Debezium ──▶ Kafka
  ORDER BY updated_at                    │                        │
       │                                 ▼                        ▼
       ▼                          ┌─────────────┐         ┌──────────────┐
  process, advance wm             │ cursor/token│         │ insert/update│
       │                          │ per page    │         │ /delete      │
       ▼                          └─────────────┘         │ + before/after│
  ┌──────────────────┐                                    └──────────────┘
  │ ⚠ misses deletes │            ⚠ token expiry           ✓ catches deletes
  │ ⚠ clock skew     │            ⚠ gaps on failover       ⚠ operational weight
  └──────────────────┘

  ALL THREE ──▶ periodic FULL RECONCILIATION (daily/weekly)
                source ids ⟷ index ids, repair the difference
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Watermark store | Last processed position | Durable table, not a file | Advanced before the work completed |
| Change enumerator | List what changed | SQL predicate, API cursor, CDC topic | Missing deletes |
| Ordering guarantee | Apply changes in order | Sequence numbers, log offsets | Out-of-order updates overwrite newer data |
| Deduplicator | Handle at-least-once delivery | Idempotent upsert by id + version | Duplicate side effects |
| Tombstone handler | Propagate deletes | Delete events or reconciliation | Deleted documents stay searchable |
| Reconciler | Periodic full comparison | Scheduled job | Absent → unbounded silent drift |
| Backfill path | Reprocess a range on demand | Parameterised run | Absent → any bug needs a full rebuild |
| Lag monitor | Source-to-index delay | Timestamp comparison | Not monitored → stale index unnoticed |

## 4. Data flow

**Watermark:** read the last watermark → select records with `updated_at > watermark` (with a **safety overlap**) → process → advance the watermark only after successful load. Deletes are invisible; reconciliation is mandatory.

**Change feed:** read the cursor → fetch the next page of changes → process → persist the new cursor. Handle expired cursors by falling back to a full sync.

**CDC:** consume the log stream → each event carries operation type, before/after images, and a sequence number → apply idempotently in sequence order → commit the offset after the write.

**All three:** run a full reconciliation on a schedule, comparing source ids to index ids, and repair the difference.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime, timedelta

class Watermark(BaseModel):
    source: str
    position: str = Field(description="Timestamp, sequence number, or opaque cursor.")
    updated_at: datetime
    safety_overlap: timedelta = Field(
        timedelta(minutes=5),
        description="Re-read this far back. Costs duplicates (idempotent anyway); "
                    "prevents misses from clock skew and in-flight transactions.")

class ChangeEvent(BaseModel):
    source_id: str
    operation: Literal["insert", "update", "delete"]
    sequence: int = Field(description="Monotonic. Reject events older than what is applied.")
    occurred_at: datetime
    after: dict | None = None
    before: dict | None = None

class ReconciliationResult(BaseModel):
    source_count: int
    index_count: int
    missing_in_index: list[str]
    orphaned_in_index: list[str]
    hash_mismatches: list[str]
    drift_ratio: float
```

## 6. Reference implementation

```python
from datetime import datetime, UTC

async def watermark_sync(source, store, state, cfg) -> dict:
    wm = await state.get_watermark(source.name)
    # Safety overlap: never trust the source clock exactly. Re-reading a few minutes
    # is cheap because upserts are idempotent; missing a record is not.
    since = wm.position_dt - wm.safety_overlap if wm else datetime.min.replace(tzinfo=UTC)

    processed, max_seen = 0, since
    async for batch in source.changed_since(since, batch_size=cfg.batch_size):
        for rec in batch:
            await process_and_upsert(rec, store)          # idempotent
            max_seen = max(max_seen, rec.source_updated_at)
            processed += 1
        # Advance only AFTER the batch is durably written.
        await state.set_watermark(source.name, position=max_seen.isoformat())

    return {"processed": processed, "watermark": max_seen.isoformat()}

async def apply_cdc_event(evt: ChangeEvent, store, state):
    """At-least-once delivery + possible reordering. Both handled by sequence checks."""
    applied = await state.get_sequence(evt.source_id)
    if applied is not None and evt.sequence <= applied:
        return                                            # duplicate or stale — drop

    if evt.operation == "delete":
        await store.delete_where(source_id=evt.source_id)
    else:
        await process_and_upsert(record_from(evt.after), store)

    await state.set_sequence(evt.source_id, evt.sequence)

async def reconcile(source, store, state) -> ReconciliationResult:
    """The safety net. Incremental sync WILL drift; this bounds it."""
    source_ids = {r.source_id: r.content_hash async for r in source.enumerate_ids()}
    index_ids = {r.source_id: r.content_hash async for r in store.enumerate_ids()}

    missing = [i for i in source_ids if i not in index_ids]
    orphaned = [i for i in index_ids if i not in source_ids]
    mismatched = [i for i in source_ids
                  if i in index_ids and source_ids[i] != index_ids[i]]

    for sid in orphaned:
        await store.delete_where(source_id=sid)           # caught the invisible deletes
    for sid in missing + mismatched:
        await reprocess(sid, source, store)

    drift = (len(missing) + len(orphaned) + len(mismatched)) / max(len(source_ids), 1)
    if drift > 0.01:
        alert(f"Sync drift {drift:.2%} — investigate the incremental path")

    return ReconciliationResult(
        source_count=len(source_ids), index_count=len(index_ids),
        missing_in_index=missing, orphaned_in_index=orphaned,
        hash_mismatches=mismatched, drift_ratio=drift)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Safety overlap | 5 min | Missed-record risk vs duplicate work | Wider for sources with long transactions or clock skew |
| Sync interval | 15 min | Freshness vs load | Match the real change rate |
| Reconciliation interval | daily | Drift bound | Weekly for very large or very stable corpora |
| Drift alert threshold | 1% | Sensitivity | Tighten once the baseline is known |
| Batch size | 500 | Memory, checkpoint granularity | Smaller for large records |
| Cursor expiry handling | fall back to full sync | Availability | Always have this fallback |
| Delete strategy | reconciliation (watermark) / events (CDC) | Correctness | CDC if deletes must propagate within minutes |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Deleted documents still searchable | Watermark sync cannot see deletes | Reconciliation orphan count | Scheduled reconciliation, or CDC |
| Records occasionally missed | Clock skew or in-flight transactions | Reconciliation `missing_in_index` | Safety overlap; use sequence numbers over timestamps |
| Old data overwrites new | Out-of-order events applied | Content differs from source | Sequence checks; reject stale events |
| Duplicate side effects | At-least-once delivery | Duplicate rows or double sends | Idempotent upsert keyed by id + sequence |
| Watermark stuck | Advanced only on full success; a poison record blocks | Watermark age | Dead-letter the poison record and advance past it |
| Watermark advanced past failures | Advanced before the write completed | Silent gaps | Advance only after durable write |
| Bulk update floods the pipeline | Migration touched every row | Change volume spike | Rate-limit; detect and route to a full-sync path |
| Index quietly stale | No lag monitoring | Source-to-index lag | Monitor and alert on lag |
| CDC connector missed events | Failover gap | Reconciliation drift | Reconciliation is the only real defence |

## 9. Anti-patterns

- **Incremental sync with no reconciliation.** Drift accumulates silently until someone notices wrong answers months later.
- **Advancing the watermark before the write succeeds.** Creates permanent, invisible gaps.
- **Timestamps as the sole position with no overlap.** Clock skew and long transactions lose records.
- **Assuming exactly-once delivery.** Every change feed is at-least-once. Be idempotent.
- **Ignoring deletes.** The most common incremental-sync bug, and the hardest to notice.
- **Building CDC when a watermark would do.** Kafka, Debezium, and connector operations are real cost — earn them.
- **No backfill path.** Every bug then requires a full rebuild.
- **Not monitoring lag.** A pipeline stopped three days ago looks identical to a healthy one.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Sync lag | Source change → index updated, p95 | < 15 min | > 1 h |
| Drift ratio | Reconciliation mismatches / total | < 0.1% | > 1% |
| Missed records | Found by reconciliation per run | 0 | ≥ 1 |
| Orphaned records | Index entries with no source | 0 | ≥ 1 |
| Watermark age | Now − watermark | < 2× sync interval | > 4× |
| Duplicate rate | Records processed more than once | < 5% (overlap is expected) | > 25% |
| Reconciliation duration | Full comparison time | < 1 h | > 4 h |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Full sync every run. Simple, self-healing. |
| v1 | Full sync exceeds the freshness budget | Watermark on `updated_at` + safety overlap |
| v2 | Deletes matter | Scheduled reconciliation with orphan cleanup |
| v3 | Source provides a change feed | Cursor-based sync with expiry fallback |
| v4 | Freshness in minutes required | Log-based CDC with sequence-ordered application |
| v5 | Many sources | Orchestrated per-source watermarks, lineage, unified drift dashboard |

## 12. Build checklist

- [ ] Watermark is stored durably, not in a file or memory.
- [ ] Watermark advances only after a durable write.
- [ ] A safety overlap re-reads a window on every run.
- [ ] All writes are idempotent — duplicates from overlap are harmless.
- [ ] Events carry sequence numbers; stale events are rejected.
- [ ] Deletes propagate, via CDC events or reconciliation.
- [ ] A full reconciliation runs on a schedule and repairs the difference.
- [ ] Drift ratio is monitored with an alert.
- [ ] Sync lag is monitored with an alert.
- [ ] A parameterised backfill path exists and has been used at least once.
- [ ] Poison records are dead-lettered so the watermark can advance.
- [ ] Cursor expiry falls back to a full sync.

## 13. Related

- [ingestion-pipeline.md](ingestion-pipeline.md) — the pipeline this feeds
- [embedding-pipeline.md](embedding-pipeline.md) — the expensive stage incremental sync protects
- [data-quality-and-pii.md](data-quality-and-pii.md) — validation on the incremental path
- [vector-store-selection.md](vector-store-selection.md) — delete support in the store
