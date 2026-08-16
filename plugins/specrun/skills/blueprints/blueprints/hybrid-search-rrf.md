+++
id = "hybrid-search-rrf"
title = "Hybrid search with RRF"
use_when = "Search misses exact strings — error codes, SKUs, function names, proper nouns — or recall is short with embeddings alone, so lexical and dense results have to be fused"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Hybrid Search with Reciprocal Rank Fusion

> Running lexical (BM25) and dense (embedding) retrieval in parallel and merging their ranked lists by rank position rather than by score.

**Tier:** foundational
**Use when:** queries contain identifiers, error codes, SKUs, function names, proper nouns, or exact phrases; or recall@k is below target with dense-only search.
**Avoid when:** the corpus is purely conceptual prose *and* measurements show BM25 adds nothing. That is rarer than teams assume — test before skipping it.
**Cost profile:** two searches instead of one (~+20–50 ms), one extra index. Typical recall gain: +5 to +15 points. Best effort-to-benefit ratio in the whole RAG stack.

---

## 1. Problem it solves

Dense embeddings encode meaning and are systematically bad at rare literal tokens. `ERR_4021`, `pnpm-lock.yaml`, and `Regulation 2016/679` are near-noise in embedding space — the model never saw them enough to place them meaningfully. A query for `ERR_4021` retrieves passages about "errors" in general.

BM25 has the mirror weakness: it matches exact terms and completely misses paraphrase. "How do I stop the app from crashing on start?" shares no terms with "Resolving boot-time segmentation faults."

Neither is fixable by tuning the other. Run both.

**Why fuse by rank, not by score:** BM25 scores are unbounded and corpus-dependent; cosine similarities live in [-1, 1] with a compressed useful range. Normalising them into comparability requires calibration that drifts with the corpus. Rank position is scale-free — RRF needs no tuning and is why it beats weighted score blending in practice.

## 2. Shape

```
                       query
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
  ┌───────────────┐             ┌───────────────┐
  │ BM25 / sparse │             │ dense / ANN   │
  │ inverted idx  │             │ HNSW, IVF     │
  └───────┬───────┘             └───────┬───────┘
   ranked list A (top-50)        ranked list B (top-50)
          │                             │
          └──────────────┬──────────────┘
                         ▼
              ┌─────────────────────┐
              │  RRF fusion         │  score(d) = Σ 1/(k + rank_i(d))
              │  k = 60             │  rank is 1-based, per list
              └──────────┬──────────┘
                         ▼
                 fused top-N  ──▶ optional reranker ──▶ top-k to the LLM
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Lexical index | Exact-term matching | BM25 (Elasticsearch/OpenSearch, `tantivy`, Postgres FTS, SPLADE) | Wrong analyzer: no stemming, wrong language, identifiers tokenised apart |
| Dense index | Semantic matching | HNSW/IVF in pgvector, Qdrant, Weaviate | See [vector-store-selection.md](vector-store-selection.md) |
| Fusion | Merge two ranked lists | RRF (~15 lines of code) | Weighted score blending with untuned, drifting weights |
| Filter | Tenant/date/type constraints | Store-native | Applied to only one of the two branches |
| Deduplicator | Same chunk from both branches | Key by chunk id | Absent → duplicates dominate top-k |

## 4. Data flow

1. Query text goes to both branches unchanged (dense may add a query prefix).
2. Each branch retrieves `n_candidates` (typically 50), applying the **same** metadata pre-filter.
3. Each result gets its 1-based rank within its own list. Scores are discarded.
4. RRF: `score(d) = Σ_lists w_i / (k + rank_i(d))`, with `k = 60`, `w_i = 1` by default. Documents in only one list still score, just lower.
5. Sort by fused score, deduplicate by chunk id, truncate to N.
6. Optionally [rerank](reranking.md) the fused top-N and take top-k for the prompt.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class SearchHit(BaseModel):
    chunk_id: str
    score: float                       # branch-native; used for debugging only
    rank: int = Field(ge=1, description="1-based position within its own list")
    source: str                        # "bm25" | "dense"

class FusionConfig(BaseModel):
    k: int = Field(60, description="RRF constant. 60 is the published default; it works. "
                                   "Lower = top ranks dominate more.")
    weights: dict[str, float] = {"bm25": 1.0, "dense": 1.0}
    n_candidates: int = Field(50, description="Per branch, before fusion")
    n_output: int = Field(20, description="After fusion; feed to the reranker")

class FusedHit(BaseModel):
    chunk_id: str
    rrf_score: float
    ranks: dict[str, int]              # {"bm25": 3, "dense": 17} — invaluable for debugging
```

## 6. Reference implementation

```python
import asyncio
from collections import defaultdict

def rrf_fuse(lists: dict[str, list[SearchHit]], cfg: FusionConfig) -> list[FusedHit]:
    scores: dict[str, float] = defaultdict(float)
    ranks: dict[str, dict[str, int]] = defaultdict(dict)

    for source, hits in lists.items():
        w = cfg.weights.get(source, 1.0)
        for hit in hits:                             # hits must be sorted best-first
            scores[hit.chunk_id] += w / (cfg.k + hit.rank)
            ranks[hit.chunk_id][source] = hit.rank

    fused = [FusedHit(chunk_id=cid, rrf_score=s, ranks=ranks[cid])
             for cid, s in scores.items()]
    fused.sort(key=lambda h: h.rrf_score, reverse=True)
    return fused[:cfg.n_output]

async def hybrid_search(query: str, tenant_id: str, cfg: FusionConfig,
                        bm25_index, vector_index, embedder) -> list[FusedHit]:
    flt = {"tenant_id": tenant_id}                   # identical filter on BOTH branches

    bm25_task = bm25_index.search(query, top_k=cfg.n_candidates, filter=flt)
    dense_task = vector_index.search(embedder.embed_query(query),
                                     top_k=cfg.n_candidates, filter=flt)
    bm25_hits, dense_hits = await asyncio.gather(bm25_task, dense_task)

    return rrf_fuse({"bm25": _ranked(bm25_hits, "bm25"),
                     "dense": _ranked(dense_hits, "dense")}, cfg)

def _ranked(hits, source: str) -> list[SearchHit]:
    return [SearchHit(chunk_id=h.id, score=h.score, rank=i + 1, source=source)
            for i, h in enumerate(hits)]
```

Postgres, single-store variant (pgvector + `tsvector`) — no second system to operate:

```sql
WITH bm25 AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC) AS rank
  FROM chunks
  WHERE tenant_id = $2 AND tsv @@ plainto_tsquery('english', $1)
  LIMIT 50
),
dense AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $3) AS rank
  FROM chunks
  WHERE tenant_id = $2
  ORDER BY embedding <=> $3
  LIMIT 50
)
SELECT COALESCE(b.id, d.id) AS id,
       COALESCE(1.0 / (60 + b.rank), 0) + COALESCE(1.0 / (60 + d.rank), 0) AS rrf
FROM bm25 b FULL OUTER JOIN dense d USING (id)
ORDER BY rrf DESC
LIMIT 20;
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| RRF `k` | 60 | Flattens rank influence | Rarely. Lower (20) to let top ranks dominate; higher (100) to flatten |
| `n_candidates` | 50 per branch | Recall ceiling | Raise to 100 if recall@50 < 0.9; costs latency |
| Weights | 1.0 / 1.0 | Branch influence | Only after measuring per-branch recall on *your* eval set |
| BM25 analyzer | language-specific stemming | Lexical quality | Match the corpus language; disable stemming for code/identifier corpora |
| BM25 `k1` / `b` | 1.2 / 0.75 | Term saturation / length normalisation | Lower `b` when documents vary wildly in length |
| Query preprocessing | none for dense, analyzer for BM25 | Match quality | Never stem the dense query |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Identifiers still not found | BM25 analyzer splits `ERR_4021` into `err` + `4021` | Query the lexical index directly | Custom analyzer preserving alphanumerics; add a keyword sub-field |
| Hybrid worse than dense alone | BM25 branch returns garbage that outranks good dense hits | Per-branch recall@50 | Fix the analyzer; if BM25 recall is genuinely < 0.3, weight it down — do not disable it blindly |
| Duplicates fill top-k | Fusion keyed by object, not by chunk id | Inspect results | Key strictly by `chunk_id` |
| Tenant leakage | Filter applied to one branch only | Two-tenant test | Assert both branches receive the identical filter |
| Latency doubled | Branches run serially | Latency breakdown | `asyncio.gather` — they are independent |
| Fusion helps offline, not online | Eval queries unlike real ones | Compare query distributions | Build the eval set from production query logs |
| Non-English recall poor | Default English analyzer | Per-language recall | Language detection → per-language analyzer/index |

## 9. Anti-patterns

- **Normalising and averaging scores.** `0.6 * cosine + 0.4 * bm25_normalised` requires calibration that drifts with corpus and query distribution. RRF needs none.
- **Skipping BM25 because "embeddings are better".** They are better at paraphrase and worse at literals. Real query logs contain both.
- **Different filters per branch.** A correctness bug, not a quality one.
- **Tuning weights before measuring per-branch recall.** You cannot tune what you have not measured.
- **Using the same analyzer for a code corpus and a prose corpus.** Stemming `getUserById` is actively harmful.
- **Fusing before filtering.** Filter first; fusing then filtering leaves you with fewer than N results.
- **`n_candidates = k`.** Fusion needs headroom. Retrieve 50, fuse, then cut to k.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Recall@50, fused | Gold chunk in fused top-50 | ≥ 0.95 | < 0.85 |
| Recall@50, per branch | Same, per branch | each ≥ 0.60 | either < 0.40 (branch is broken) |
| Fusion lift | Fused recall − best single branch | ≥ +5 pts | ≤ +1 pt (investigate) |
| Overlap rate | Chunks appearing in both lists | 20–50% | > 80% (branches are redundant) |
| Latency p95 | Both branches + fusion | < 250 ms | > 500 ms |
| Identifier query recall | Recall on a code/ID query slice | ≥ 0.95 | < 0.80 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Dense only |
| v1 | Identifier/exact queries fail | Add BM25 + RRF, `k=60`, equal weights |
| v2 | Corpus is code or multi-language | Per-type analyzers, keyword sub-fields, per-language indices |
| v3 | Precision lags recall | Add a [reranker](reranking.md) over the fused top-20 |
| v4 | Branch quality differs by query type | Query-type-conditional weights (set by measurement, not intuition) |
| v5 | Lexical index is a burden to operate | Learned sparse (SPLADE) in the same vector store, fused the same way |

## 12. Build checklist

- [ ] Both branches receive the identical metadata pre-filter.
- [ ] Both branches run concurrently.
- [ ] Fusion is RRF over ranks, `k = 60`, not blended scores.
- [ ] Deduplication is keyed by chunk id.
- [ ] The BM25 analyzer preserves identifiers (`ERR_4021`, `getUserById`).
- [ ] The BM25 analyzer matches the corpus language.
- [ ] `n_candidates` (50) is well above the final `k`.
- [ ] Per-branch recall@50 is measured separately, not just fused recall.
- [ ] An identifier/exact-match slice exists in the eval set.
- [ ] `ranks` per branch are retained on results for debugging.

## 13. Related

- [rag-baseline.md](rag-baseline.md) — the system this upgrades
- [reranking.md](reranking.md) — the natural next stage after fusion
- [query-transformation.md](query-transformation.md) — improving the query before it reaches either branch
- [vector-store-selection.md](vector-store-selection.md) — stores with both indices built in
