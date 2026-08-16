---
name: diagnose-rag-failure
description: Localises a wrong RAG answer to a specific stage - retrieval miss, ranking failure, or generation failure - by checking each stage against evidence rather than guessing. Use when a RAG system returns a wrong or incomplete answer, hallucinates despite having documents, says it cannot find something that exists, cites the wrong source, or when retrieval quality regressed after a change.
metadata:
  version: "1.0"
  source: AI Engineer Assets
---

# Diagnose a RAG Failure

"The answer is wrong" has four causes with four different fixes. Find which one before changing anything.

## When this applies

- Wrong or incomplete answer to a question the corpus can answer
- Hallucinated content despite relevant documents existing
- "I cannot find that" when the document exists
- Citations pointing at the wrong source
- A regression after changing chunking, embeddings, k, or the prompt

## Do not use for

- Building a pipeline → `build-rag-pipeline`
- Creating the eval set → `build-rag-evalset`

## Inputs to collect first

| Input | Why needed | Default if unspecified |
|---|---|---|
| The failing question | The case | **Blocking** |
| The expected answer | Defines "wrong" | **Blocking** |
| The document that should answer it | Gives you the gold chunk | **Blocking** — find it manually if needed |
| Retrieved chunks with scores | The evidence | Re-run the query with logging |
| Recent config changes | Regression candidates | `git log` on the retrieval config |

## Procedure

### Step 1 — Locate the gold chunk

Find, by hand, the chunk that *should* answer the question. Note its id.

If no chunk contains the answer, the failure is **upstream of retrieval**: either the
document was never ingested, or chunking split the answer across two chunks. Check the
index for the `doc_id` first — a missing document is the most common "retrieval bug".

**Stop condition:** you have a gold chunk id, or you know the document is not indexed.

### Step 2 — Is the gold chunk retrievable at all?

Query the index directly with the gold chunk's own text as the query. It must come back rank 1.

- Not rank 1 → the index is broken: wrong embedding model at query vs index time, wrong
  distance metric, a stale index, or a filter excluding it.

**Stop condition:** you know whether the chunk is reachable at all.

### Step 3 — Is it retrieved for the real question?

Run the actual question. Record the gold chunk's rank across the candidate set (before
reranking, before truncation to k).

| Rank | Class | Go to |
|---|---|---|
| Not in top-50 | **RETRIEVAL MISS** | Step 4 |
| In top-50, not in top-k | **RANKING FAILURE** | Step 5 |
| In top-k sent to the model | **GENERATION FAILURE** | Step 6 |

**Stop condition:** exactly one class, with the rank recorded.

### Step 4 — Retrieval miss: find the sub-cause

Run each branch separately and record the gold chunk's rank in each.

| Observation | Cause | Fix |
|---|---|---|
| BM25 finds it, dense does not | Vocabulary/semantic gap | `../blueprints/blueprints/query-transformation.md` (HyDE); check the query prefix |
| Dense finds it, BM25 does not | Analyzer problem | Check tokenisation of identifiers; language analyzer |
| Neither finds it | Chunk lacks context, or query is unlike the corpus | `../blueprints/blueprints/contextual-retrieval.md`; read the chunk cold |
| Chunk text is fragmentary | Chunking split the answer | `../blueprints/blueprints/chunking-strategies.md`; raise target size or add overlap |
| Only dense branch exists | No lexical index | Add BM25 → `hybrid-search-rrf.md` |

**Stop condition:** the sub-cause is confirmed by a per-branch rank measurement.

### Step 5 — Ranking failure

- No reranker → add one (`reranking.md`). This is the exact case it exists for.
- Reranker present but the gold chunk scored low:
  - Check chunk token count against the reranker's input limit — silent truncation is the
    most common cause.
  - Check the score threshold: was the gold chunk cut by it?
  - Check the per-document diversity cap: did it evict the gold chunk?

**Stop condition:** the specific stage that demoted the chunk is identified.

### Step 6 — Generation failure

The right chunk was in the prompt. Determine which failure:

| Observation | Cause | Fix |
|---|---|---|
| Answer contradicts the chunk | Model overrode context with priors | Temperature 0; stronger "answer only from context"; stronger model |
| Answer ignores the chunk, is generic | Too much noise at high k | Lower k; rerank; better source delimiters |
| Answer invents facts | No abstain path, or weak grounding instruction | Explicit abstention phrase; validate citations post-hoc |
| Answer cites the wrong id | Ids not clearly bound to text | XML-delimited sources with id attributes |
| Answer partially correct | Question is compound | `../blueprints/blueprints/query-transformation.md` decomposition |

Confirm by re-running generation with *only* the gold chunk in context. If it answers
correctly, the problem is noise, not comprehension.

**Stop condition:** confirmed by the single-chunk test.

### Step 7 — Add the case to the eval set and fix

Add the question with its gold chunk id to `evals/dataset.jsonl`. Make the fix. Confirm the
case passes and that the rest of the suite did not regress.

**Stop condition:** the case fails before the fix and passes after; no other metric dropped.

## Output contract

```
QUESTION:     "How do I raise the connection limit on the gateway?"
GOLD CHUNK:   docs-gateway::14::c9f1  (Rate Limits section)
STAGE:        retrieval miss
EVIDENCE:     gold rank — BM25: 2, dense: not in top-50, fused: 41
ROOT CAUSE:   chunk reads "It supports up to 40 concurrent connections"; the embedding
              has no signal for "gateway" — the antecedent is in the previous section
FIX:          structural chunking with section_path prefixed into the embedded text
              [indexing layer]
VERIFIED:     gold rank fused 41 → 1; recall@20 across the suite 0.87 → 0.94
REGRESSION:   evals/dataset.jsonl +1 item (category: factual)
```

## Verification

- [ ] The gold chunk was identified manually, not assumed
- [ ] The stage is supported by a recorded rank, not an impression
- [ ] The single-chunk test was run for generation failures
- [ ] The fix targets the identified stage, not an adjacent one
- [ ] The case is now in the eval set
- [ ] Suite-wide metrics did not regress

## Common mistakes

| Mistake | Why it happens | Correct action |
|---|---|---|
| Changing chunk size first | It's the most familiar knob | Locate the stage first |
| Assuming retrieval failed | Most visible hypothesis | Check the rank — it is often a ranking or generation failure |
| Raising k to "get more context" | Seems free | More noise usually makes generation worse |
| Testing with the chunk's own words | Feels like a test | Test with the real user question |
| Not checking whether the doc is indexed | Too obvious to check | Check it first; it is common |
| One change, no measurement | Impatience | One change, one number |

## References

- `../blueprints/blueprints/rag-evaluation.md` — the metrics used here
- `../blueprints/blueprints/hybrid-search-rrf.md` — per-branch debugging
- `../blueprints/blueprints/reranking.md` — truncation and threshold traps
- `../blueprints/blueprints/chunking-strategies.md` — split-related misses
