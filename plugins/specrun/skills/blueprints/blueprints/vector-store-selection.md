+++
id = "vector-store-selection"
title = "Vector store selection"
use_when = "Choosing where embeddings live and which index and metadata filtering they use; or the store's recall, p95 latency or cost has become the constraint"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Vector Store Selection

> Choosing where embeddings live, which ANN index they use, and how metadata filtering interacts with search — a decision that is cheap at 100k vectors and expensive to reverse at 100M.

**Tier:** foundational
**Use when:** starting any retrieval system, or when p95 latency, recall, or cost has become the constraint.
**Avoid when:** the corpus is under ~10k chunks — a numpy array of vectors with brute-force cosine is exact, instant, and has zero operational cost. Do that.
**Cost profile:** dominated by memory. HNSW at 1536 dimensions costs roughly 6–8 KB per vector in RAM; 10M vectors ≈ 60–80 GB before quantisation.

---

## 1. Problem it solves

Every store does "similarity search", so the choice looks arbitrary until one of four things bites:

1. **Filtering.** Multi-tenant search needs the tenant filter applied *during* traversal. Stores that post-filter return fewer than k results and silently degrade recall.
2. **Scale economics.** HNSW is fast and memory-hungry. At 50M vectors the difference between quantised and unquantised is a rack.
3. **Operational surface.** A separate vector database is another system to run, back up, secure, and keep in sync with your source of truth.
4. **Hybrid search.** If you need BM25 too, a store with a built-in lexical index removes a whole component.

The right question is not "which is best" but "what breaks first at my scale, and which store makes that not break".

## 2. Shape

```
   corpus size          recommended shape
   ───────────          ─────────────────
   < 10k        numpy / SQLite + brute force        exact, zero ops
   10k – 1M     Postgres + pgvector                 one database, transactional, filters via SQL
                LanceDB / Chroma (embedded)         no server, file-backed
   1M – 50M     Qdrant / Weaviate / Milvus          dedicated, filtered HNSW, quantisation
                Postgres + pgvector + pgvectorscale still viable with tuning
   > 50M        Milvus / Vespa / managed            sharding, disk-based indexes
   any + hosted Pinecone / Turbopuffer / managed    trade cost for zero ops

   ┌──────────── index families ────────────┐
   │ FLAT   exact, O(n), no build           │  ≤100k, or a recall ground truth
   │ HNSW   graph, fast, RAM-hungry         │  the default everywhere else
   │ IVF    cluster-based, less RAM         │  large + memory-constrained
   │ DiskANN/SSD  disk-resident             │  >50M with modest RAM
   │ + PQ/SQ/BQ quantisation                │  4-32× memory cut, some recall loss
   └────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| ANN index | Approximate nearest neighbours | HNSW, IVF-PQ, DiskANN | Parameters left at defaults; recall unmeasured |
| Metadata filter | Constrain the candidate set | Payload index + filtered traversal | Post-filtering → fewer than k results |
| Payload store | Chunk text and metadata | Same store, or a separate DB | Duplicated and drifting from the source of truth |
| Lexical index | BM25 for [hybrid](hybrid-search-rrf.md) | Built-in, or a separate engine | A second system to keep in sync |
| Quantiser | Compress vectors | PQ, scalar, binary | Applied without measuring the recall cost |
| Sync process | Keep the index current with sources | CDC, scheduled reindex | Deletes never propagate |
| Backup/restore | Recover the index | Snapshots, or rebuild from source | Never tested |

## 4. Data flow

Write: source change → chunk → embed → upsert by stable id → index update (background in most stores) → searchable after some lag.

Read: query vector + filter → filtered ANN traversal → top-k with scores → payload fetch → return.

The decision points: **is filtering applied during traversal or after** (correctness), and **does the index live in RAM or on disk** (cost at scale).

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal, Protocol

class IndexConfig(BaseModel):
    kind: Literal["flat", "hnsw", "ivf", "ivf_pq", "diskann"] = "hnsw"
    dimensions: int
    metric: Literal["cosine", "dot", "l2"] = "cosine"   # follow the embedding model card
    # HNSW
    m: int = Field(16, description="Edges per node. Higher = better recall, more RAM.")
    ef_construction: int = Field(200, description="Build-time quality. Higher = slower build.")
    ef_search: int = Field(100, description="Query-time. THE recall/latency dial. Tune this.")
    # IVF
    nlist: int = Field(1024, description="Clusters. Rule of thumb: 4*sqrt(n).")
    nprobe: int = Field(16, description="Clusters searched. The IVF recall dial.")
    quantization: Literal["none", "scalar", "product", "binary"] = "none"

class VectorStore(Protocol):
    def upsert(self, ids: list[str], vectors, payloads: list[dict]) -> None: ...
    def search(self, vector, top_k: int, filter: dict) -> list[tuple[str, float]]: ...
    def delete(self, ids: list[str]) -> None: ...
    def delete_where(self, filter: dict) -> None: ...      # required for document removal
```

## 6. Reference implementation

The correctness test that matters most — **filtering must be applied during traversal**:

```python
def test_filtered_recall(store, n_tenants=2, k=10):
    """A store that post-filters returns < k results. Run this before choosing."""
    for tenant in range(n_tenants):
        hits = store.search(random_vector(), top_k=k, filter={"tenant_id": f"t{tenant}"})
        assert len(hits) == k, (
            f"Got {len(hits)}/{k} for tenant t{tenant}. This store post-filters — "
            f"recall silently degrades as the filter gets more selective.")
        assert all(store.payload(h[0])["tenant_id"] == f"t{tenant}" for h in hits), \
            "LEAKAGE: results from another tenant."
```

Measuring real recall against exact search — do this before tuning anything:

```python
import numpy as np

def measure_recall(store, vectors: np.ndarray, queries: np.ndarray, k=10) -> float:
    """Ground truth by brute force, then compare. Without this you are guessing."""
    recalls = []
    for q in queries:
        sims = (vectors @ q) / (np.linalg.norm(vectors, axis=1) * np.linalg.norm(q))
        exact = set(np.argsort(-sims)[:k].tolist())
        approx = {int(i) for i, _ in store.search(q, top_k=k, filter={})}
        recalls.append(len(exact & approx) / k)
    return float(np.mean(recalls))

# Tune ef_search against the recall target, not by feel:
for ef in (32, 64, 100, 200, 400):
    store.set_ef_search(ef)
    print(ef, measure_recall(store, vectors, queries), timed_p95(store, queries))
```

Postgres + pgvector — the right default for most teams up to a few million chunks:

```sql
CREATE TABLE chunks (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  text          TEXT NOT NULL,
  section_path  TEXT[],
  updated_at    TIMESTAMPTZ NOT NULL,
  embedding     VECTOR(1536) NOT NULL,
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
CREATE INDEX ON chunks USING gin (tsv);          -- BM25-ish, enables hybrid in one system
CREATE INDEX ON chunks (tenant_id, doc_id);      -- makes the filter cheap

SET hnsw.ef_search = 100;                        -- per session; the recall/latency dial
```

One database means one backup, one transaction boundary, and no sync process between your source of truth and your index. That is worth a great deal before you actually need a dedicated vector database.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `m` (HNSW) | 16 | Recall ceiling, RAM, build time | 32–48 for high-dimensional or high-recall needs |
| `ef_construction` | 200 | Index quality, build time | 400 when build time is not a constraint |
| `ef_search` | 100 | **The** recall/latency dial at query time | Tune against measured recall, per deployment |
| `nprobe` (IVF) | 16 | IVF recall/latency dial | Raise until recall target is met |
| Quantisation | none | 4–32× memory cut, some recall loss | Above ~10M vectors; always measure the recall delta |
| Dimensions | model default | Everything downstream | Matryoshka models allow truncation — measure the recall cost |
| Metric | cosine | Correctness | Follow the embedding model card; do not guess |
| Replicas | 1 | Availability, read throughput | ≥ 2 for production |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Fewer than k results with a filter | Post-filtering | The filtered-recall test above | Choose a store with filtered traversal; or pre-partition by tenant |
| Recall drops as the corpus grows | `ef_search` fixed while the graph grew | Recall measured over time | Re-tune `ef_search`; monitor recall, not just latency |
| p95 latency 10× p50 | Index rebuild / compaction during queries | Latency vs maintenance windows | Schedule maintenance; add replicas |
| OOM at 10M vectors | HNSW in RAM, unquantised | Memory per vector × count | Quantise, or move to a disk-based index |
| Deleted documents still returned | Deletes never propagated | Spot-check removed docs | `delete_where(doc_id=...)` on re-index; tombstones |
| Index and source drift | No sync process | Row counts vs source counts | CDC or scheduled reconciliation |
| Cross-tenant results | Filter not enforced at the store | Two-tenant test in CI | Enforce in the store; test it |
| Migration takes a week | No re-embed/reindex path | Attempt a dry run | Keep raw text as the source of truth so any index is rebuildable |
| Cost 5× forecast | Managed per-vector pricing at scale | Cost per million vectors | Model the cost at target scale before committing |

## 9. Anti-patterns

- **A dedicated vector database for 50k chunks.** Postgres already runs in your stack and does this well. Every extra system is backups, monitoring, access control, and sync.
- **Never measuring recall.** ANN is *approximate*. If you have not compared to exact search, you do not know what you are getting.
- **Quantising without measuring.** Binary quantisation can cost 10+ points of recall on some models and almost nothing on others. Measure.
- **Post-filtering by tenant.** A correctness bug dressed as a performance choice.
- **Treating the vector store as the source of truth.** It is a derived index. Keep raw text elsewhere so you can always rebuild.
- **Choosing by benchmark leaderboards.** Public benchmarks use unfiltered queries and clean data. Your filtered, multi-tenant workload is a different problem.
- **Ignoring the delete path.** Every store does upserts well; deletes and re-indexing are where the operational pain lives.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Recall@10 vs exact | Measured against brute force | ≥ 0.95 | < 0.90 |
| Filtered result count | Results returned when k requested | = k | < k |
| Search latency p95 | Query only | < 50 ms | > 200 ms |
| Index lag | Upsert → searchable | < 60 s | > 10 min |
| Memory per vector | RAM / vector count | Within budget | > 1.5× forecast |
| Index/source parity | Index count vs source count | ±0.1% | > 1% drift |
| Cross-tenant leakage | Foreign results | 0 | ≥ 1 (incident) |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | < 10k chunks | numpy brute force. Exact, free, no ops. |
| v1 | < 1M chunks | Postgres + pgvector, HNSW + GIN for hybrid |
| v2 | Filtered latency degrades | Tune `ef_search`, partition by tenant, add read replicas |
| v3 | > 5M chunks or complex filters | Dedicated store (Qdrant/Weaviate/Milvus) with filtered HNSW |
| v4 | Memory cost dominates | Scalar or product quantisation, recall delta measured |
| v5 | > 50M chunks | Sharding, disk-based indexes, tiered hot/cold storage |

## 12. Build checklist

- [ ] Confirmed the corpus is large enough to need ANN at all.
- [ ] The filtered-recall test passes: k results returned with a selective filter.
- [ ] Two-tenant leakage test in CI.
- [ ] Recall@10 measured against exact brute force on a sample.
- [ ] `ef_search` / `nprobe` tuned against a recall target, not by feel.
- [ ] The distance metric matches the embedding model card.
- [ ] Raw chunk text is stored outside the index so it can be rebuilt.
- [ ] A delete-by-document path exists and is tested.
- [ ] Index-to-source parity is monitored.
- [ ] Memory and cost modelled at 10× current scale.
- [ ] Quantisation, if used, has a measured recall delta.

## 13. Related

- [rag-baseline.md](rag-baseline.md) — what sits on top
- [hybrid-search-rrf.md](hybrid-search-rrf.md) — stores with a built-in lexical index remove a component
- [rag-evaluation.md](rag-evaluation.md) — measuring recall properly
- [incremental-sync-cdc.md](incremental-sync-cdc.md) — keeping the index current
- [cost-and-rate-limits.md](cost-and-rate-limits.md) — modelling the bill
