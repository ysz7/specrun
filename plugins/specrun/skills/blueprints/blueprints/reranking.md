+++
id = "reranking"
title = "Reranking"
use_when = "The right chunk is retrieved but ranked far down: recall is high and precision in the top few is low, or k must be cut before the prompt without losing the answer"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Reranking

> A second-stage model that scores each (query, chunk) pair jointly and reorders a large candidate set down to a small, high-precision one.

**Tier:** intermediate
**Use when:** recall@50 is high (≥ 0.9) but precision@5 is low (< 0.6) — the right chunk is retrieved but buried; or you need to cut k for the LLM without losing the answer.
**Avoid when:** recall@50 is itself low. A reranker cannot promote a chunk that was never retrieved — fix retrieval first.
**Cost profile:** +50–300 ms and a per-document cost for 20–50 candidates. Typical precision@5 gain: +15 to +30 points.

---

## 1. Problem it solves

Bi-encoders (normal embeddings) encode the query and the document **independently**, then compare vectors. That independence is what makes ANN search fast over millions of documents — and it is also what caps its accuracy: the document vector was computed with no knowledge of the query.

A cross-encoder reads query and document **together** and outputs a relevance score. It can tell that a passage mentioning "connection timeout" answers "why does my client hang?" while another passage mentioning both words in an unrelated context does not. That costs a full forward pass per pair, so it cannot scan a corpus — but over 50 candidates it is cheap and dramatically more accurate.

The division of labour: **retrieval maximises recall over millions; reranking maximises precision over dozens.**

## 2. Shape

```
  query ─────────────────────────────────┐
    │                                    │
    ▼                                    ▼
 ┌──────────────────┐            ┌──────────────────────┐
 │ retrieval        │ top-50     │  CROSS-ENCODER       │
 │ (hybrid/dense)   │───────────▶│  score(query, chunk) │  50 forward passes
 │ bi-encoder: fast │            │  slow, accurate      │  (batched, parallel)
 │ recall-oriented  │            └──────────┬───────────┘
 └──────────────────┘                       │ sorted by relevance
                                            ▼
                                   top-5 ──▶ LLM prompt
                                   (+ score threshold → abstain if all below)
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| First-stage retriever | Recall over the corpus | [Hybrid search](hybrid-search-rrf.md) | Low recall caps the whole pipeline |
| Cross-encoder | Joint relevance scoring | Hosted rerank APIs; `bge-reranker`, `mxbai-rerank`, `ms-marco-MiniLM` locally | Input truncation silently drops the relevant half of a chunk |
| Batcher | Group pairs into one request | Client-side | One request per pair → 50× latency |
| Threshold gate | Drop everything below a score | Custom | Absent → irrelevant chunks always fill top-k |
| Diversity filter | Prevent one document owning all slots | MMR / per-doc cap | Absent → 5 chunks from one page |
| Fallback | Behaviour when the reranker is down | Return first-stage order | Absent → retrieval outage |

## 4. Data flow

1. First stage returns 20–100 candidates (more candidates = more recall = more rerank cost).
2. Build `(query, chunk_text)` pairs. **Check truncation:** most rerankers cap at 512 tokens.
3. Score in batches, concurrently.
4. Sort descending by score.
5. Apply the score threshold — chunks below it are noise, not "the best of a bad set".
6. Apply per-document diversity cap.
7. Take top-k (typically 3–5) for the prompt.
8. If nothing clears the threshold, abstain rather than answering from irrelevant context.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Protocol

class RerankConfig(BaseModel):
    n_candidates: int = Field(50, description="From the first stage. More = better recall, more cost.")
    n_output: int = Field(5, description="Into the prompt.")
    score_threshold: float = Field(0.3, description="Calibrate on YOUR eval set — scales differ per model.")
    max_per_document: int = Field(2, description="Diversity cap.")
    max_chunk_tokens: int = Field(512, description="Reranker input limit. Exceeding = silent truncation.")
    timeout_ms: int = 2_000

class RerankResult(BaseModel):
    chunk_id: str
    score: float
    original_rank: int
    new_rank: int

class Reranker(Protocol):
    def score(self, query: str, documents: list[str]) -> list[float]: ...
```

## 6. Reference implementation

```python
import asyncio, logging
from collections import Counter

async def rerank(query: str, candidates: list[Chunk], reranker,
                 cfg: RerankConfig) -> list[Chunk]:
    if not candidates:
        return []

    # Truncation is the #1 silent reranker bug: score the text the model will actually see.
    texts = [truncate_tokens(c.text, cfg.max_chunk_tokens) for c in candidates]

    try:
        scores = await asyncio.wait_for(
            reranker.score(query, texts), timeout=cfg.timeout_ms / 1000)
    except (asyncio.TimeoutError, Exception) as e:
        logging.warning("rerank failed, degrading to first-stage order: %s", e)
        return candidates[:cfg.n_output]        # NEVER fail the request on a rerank failure

    ranked = sorted(zip(candidates, scores, range(len(candidates))),
                    key=lambda t: t[1], reverse=True)

    out, per_doc = [], Counter()
    for chunk, score, orig_rank in ranked:
        if score < cfg.score_threshold:
            break                                # sorted, so everything after is worse
        if per_doc[chunk.doc_id] >= cfg.max_per_document:
            continue
        per_doc[chunk.doc_id] += 1
        chunk.rerank_score = score
        out.append(chunk)
        if len(out) >= cfg.n_output:
            break
    return out                                   # may be empty → caller abstains
```

LLM-as-reranker, when no cross-encoder is available. Slower and pricier, but needs no extra infrastructure:

```python
LISTWISE_SYSTEM = """Rank passages by how well they answer the question.

Return JSON: {"ranking": [{"id": "...", "relevance": 0.0-1.0}, ...]}
- relevance 1.0 = directly and completely answers the question
- relevance 0.5 = related and partially useful
- relevance 0.0 = same topic but does not answer it
Judge ONLY whether the passage answers THIS question. Topical similarity is not relevance.
Include every passage id exactly once."""

async def llm_rerank(query: str, candidates: list[Chunk], cfg: RerankConfig):
    listing = "\n\n".join(f"[{c.id}]\n{truncate_tokens(c.text, 300)}" for c in candidates)
    resp = await client.messages.create(
        model="<FAST_MODEL_ID>", max_tokens=2000, temperature=0,
        system=LISTWISE_SYSTEM,
        messages=[{"role": "user", "content": f"Question: {query}\n\nPassages:\n{listing}"}])
    ranking = json.loads(resp.content[0].text)["ranking"]
    by_id = {c.id: c for c in candidates}
    return [by_id[r["id"]] for r in ranking
            if r["relevance"] >= cfg.score_threshold and r["id"] in by_id][:cfg.n_output]
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `n_candidates` | 50 | Recall ceiling vs cost | Raise to 100 only if recall@50 < 0.95; latency grows roughly linearly |
| `n_output` | 5 | Prompt size and noise | 3 for focused QA; 8 for synthesis across sources |
| `score_threshold` | model-specific | Abstention rate | **Must be calibrated** — plot score distributions for relevant vs irrelevant pairs |
| `max_per_document` | 2 | Source diversity | 1 for comparison questions; unlimited for deep single-document reading |
| `max_chunk_tokens` | 512 | Truncation | Match the reranker's real limit; check the model card |
| Timeout | 2 s | Tail latency | Always degrade to first-stage order, never fail |
| Model size | small/base | Latency vs accuracy | Larger models help most on subtle relevance |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Reranking doesn't help | First-stage recall is the bottleneck | recall@50 before reranking | Fix retrieval; reranking cannot invent candidates |
| Long chunks always score low | Silent truncation at 512 tokens | Compare chunk token counts to the limit | Shorten chunks, or score a summary, or use a long-context reranker |
| Threshold drops everything | Threshold copied from another model | Score distribution on a labelled set | Calibrate per model; scores are not comparable across models |
| Latency p95 spiked | Sequential scoring, or `n_candidates` too high | Latency vs candidate count | Batch, parallelise, cap candidates |
| Top-5 all from one document | No diversity cap | Distinct doc_ids in output | `max_per_document` |
| Reranker outage takes down search | No fallback | Error rate | Timeout + degrade to first-stage order |
| Helps on eval, not in production | Eval queries unlike real ones | Compare distributions | Build the eval set from production logs |
| Cost doubled | Reranking every query including trivial ones | Cost per query | Skip reranking when the first-stage top-1 score is already decisive |

## 9. Anti-patterns

- **Reranking to fix low recall.** It reorders; it cannot retrieve. Measure recall@50 first.
- **Copying a threshold across models.** Rerank scores have no shared scale. Calibrate.
- **Ignoring the input limit.** A 1 500-token chunk scored by a 512-token reranker is scored on its first third. This is silent and common.
- **Hard-failing on reranker errors.** It is an enhancement. Degrade to first-stage order.
- **`n_candidates = n_output`.** Then there is nothing to rerank.
- **No score threshold.** Guarantees the top-5 always get sent even when all are irrelevant, converting an abstention into a hallucination.
- **Reranking after truncating to k=5.** The order is what you are trying to fix; rerank the wide set.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Precision@5 after rerank | Relevant chunks in top-5 | ≥ 0.80 | < 0.60 |
| Precision lift | Precision@5 after − before | ≥ +15 pts | ≤ +5 pts (question the cost) |
| Recall preservation | Gold chunk still in top-5 | ≥ 0.90 | < 0.80 |
| Rerank latency p95 | Scoring only | < 300 ms | > 800 ms |
| Fallback rate | Degraded to first-stage | < 1% | > 5% |
| Abstain rate | Nothing cleared the threshold | 5–15% | > 30% (threshold too high) or ~0% (too low) |
| Cost per query | Rerank cost | < 20% of total | > 40% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | No reranking; raise k instead |
| v1 | Precision@5 < 0.6 with recall@50 > 0.9 | Hosted reranker over top-50, threshold calibrated |
| v2 | Latency or cost pressure | Self-hosted small cross-encoder; batch and parallelise |
| v3 | Domain relevance is idiosyncratic | Fine-tune the reranker on your labelled pairs |
| v4 | Chunks exceed the reranker window | Long-context reranker, or score a chunk summary |
| v5 | Cost per query matters | Conditional reranking: skip when first-stage top-1 is decisive |

## 12. Build checklist

- [ ] recall@50 measured *before* adding a reranker, and it is ≥ 0.9.
- [ ] Chunk text is truncated to the reranker's real limit before scoring.
- [ ] `score_threshold` calibrated on a labelled set for this specific model.
- [ ] Scoring is batched and concurrent.
- [ ] A timeout exists and failure degrades to first-stage order.
- [ ] A per-document diversity cap is applied.
- [ ] An empty result after thresholding leads to abstention, not a forced answer.
- [ ] Precision@5 before/after is tracked, with the lift reported.
- [ ] `original_rank` and `new_rank` are retained for debugging.

## 13. Related

- [hybrid-search-rrf.md](hybrid-search-rrf.md) — the first stage that feeds this
- [rag-baseline.md](rag-baseline.md) — where the top-k lands
- [rag-evaluation.md](rag-evaluation.md) — measuring recall and precision properly
- [evaluator-optimizer.md](evaluator-optimizer.md) — LLM-as-judge mechanics, shared with LLM reranking
