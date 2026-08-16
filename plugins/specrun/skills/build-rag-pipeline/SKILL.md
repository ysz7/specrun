---
name: build-rag-pipeline
description: Builds a production-shaped retrieval-augmented generation pipeline - parsing, chunking with metadata, embedding, hybrid retrieval, reranking, grounded answering with citations and abstention. Use when the user asks to build RAG, add document search, make a chatbot over their docs, index a knowledge base, do semantic search, or let a model answer from a corpus it was not trained on. Also use when an existing RAG system needs hybrid search, reranking, or evaluation added.
metadata:
  version: "1.0"
  source: AI Engineer Assets
---

# Build a RAG Pipeline

## When this applies

- "Let the model answer questions about our documentation"
- Semantic or hybrid search over a corpus
- An existing vector search needs to become a real pipeline

## Do not use for

- Diagnosing a specific wrong answer → `diagnose-rag-failure`
- Building the labelled eval set → `build-rag-evalset`
- Multi-hop questions requiring an agent → see `../blueprints/blueprints/agentic-rag.md`

## Inputs to collect first

| Input | Why needed | Default if unspecified |
|---|---|---|
| Corpus size and format | Decides store and parser | Ask — this changes everything |
| Multi-tenant? | Tenancy is a correctness requirement, not a feature | Assume yes; build the filter in |
| Update frequency | Batch vs incremental indexing | Daily batch |
| Query examples (5–10 real ones) | Reveals whether exact-match matters | Ask — do not skip this |
| Latency budget | Reranking and transformation fit or don't | 2 s end to end |

**Check first:** if the whole corpus is under ~100k tokens and rarely changes, put it in the
prompt with caching instead. Say so and stop — it will beat a new RAG system on quality and effort.

## Procedure

### Step 1 — Parse, preserving structure

Extract text **plus** heading hierarchy, page numbers, and table boundaries. A parser that
flattens structure caps the quality of everything downstream.

**Stop condition:** parsed output for 3 sample documents retains headings and readable tables.

### Step 2 — Chunk structurally, with metadata

Split on headings first, recursively within oversized sections. Target ~400 tokens counted
with the **embedding model's tokenizer**. Attach to every chunk: `doc_id`, `tenant_id`,
`source_uri`, `section_path`, `page`, `chunk_index`, `updated_at`, `content_hash`.

Chunk id = `sha256(doc_id + index + text)` so re-indexing replaces rather than duplicates.

**Stop condition:** print 20 random chunks and read them cold. If you cannot tell what they are about, go to Step 3 early.

### Step 3 — Add context to chunks (if needed)

Free version first: prefix `"{doc_title} — {section_path}. "`. Measure. Only if that is
insufficient, use LLM contextualisation with the document as a cached prefix
(`../blueprints/blueprints/contextual-retrieval.md` §6).

**Stop condition:** sampled chunks are comprehensible standalone.

### Step 4 — Embed and index both ways

Same model for queries and documents, with the correct asymmetric prefixes. Index the
contextualised text in **both** the vector index and a BM25/`tsvector` index.

Store choice: Postgres + pgvector unless the corpus exceeds a few million chunks
(`../blueprints/blueprints/vector-store-selection.md`).

**Stop condition:** the filtered-recall test passes — a selective tenant filter still returns k results.

### Step 5 — Hybrid retrieval with RRF

Both branches, same pre-filter, concurrent, 50 candidates each, fused by
`score = Σ 1/(60 + rank)`. Never blend normalised scores.

**Stop condition:** an identifier query (`ERR_4021`) retrieves the right chunk.

### Step 6 — Rerank to top-5

Cross-encoder over the fused top-20 to top-50. Truncate chunk text to the reranker's real
input limit. Calibrate a score threshold on your own data. Timeout → degrade to first-stage
order, never fail the request.

**Stop condition:** precision@5 measurably above the unreranked baseline.

### Step 7 — Answer with grounding

Temperature 0. Delimit each source with its id. Instruct: cite ids, answer only from context,
and abstain with an exact phrase when the context does not contain the answer. Validate
post-hoc that every cited id was actually retrieved.

**Stop condition:** a question with no supporting document produces the abstention, not a guess.

### Step 8 — Evaluate

Do not skip. Use `build-rag-evalset`. Minimum: 50 questions with gold chunk ids, 10–15%
unanswerable, recall@k in CI.

**Stop condition:** recall@20, precision@5, and faithfulness are all reported in CI.

## Output contract

```
rag/
├── ingest/
│   ├── parse.py        # structure-preserving
│   ├── chunk.py        # structural + recursive, token-counted, metadata
│   └── index.py        # embed + upsert to both indices, content-hash gated
├── retrieve/
│   ├── hybrid.py       # BM25 + dense, RRF, identical pre-filter
│   └── rerank.py       # cross-encoder, threshold, timeout, fallback
├── answer/
│   ├── prompt.py       # delimiters, citation and abstention instructions
│   └── generate.py     # temperature 0, citation validation
├── evals/
│   ├── dataset.jsonl   # question, gold_chunk_ids, gold_answer, category
│   └── run.py          # recall@k, precision@5, faithfulness, per-category
└── config.py           # every knob from §7 of the architecture files
```

## Verification

- [ ] Two-tenant test: no cross-tenant results, and k results returned with the filter
- [ ] Identifier query (`ERR_4021`) retrieves the right chunk
- [ ] Paraphrased query with no shared terms retrieves the right chunk
- [ ] Unanswerable question triggers the exact abstention phrase
- [ ] Deleting a source document removes its chunks from both indices
- [ ] Re-indexing an unchanged document performs zero embedding calls
- [ ] Every cited id in an answer exists in the retrieved set
- [ ] recall@20 ≥ 0.9 on the eval set

## Common mistakes

| Mistake | Why it happens | Correct action |
|---|---|---|
| Building RAG when the corpus fits in context | RAG is the expected answer | Check the token count first |
| Character-based chunking | Tutorial default | Use the embedding model's tokenizer |
| Dense-only retrieval | Embeddings feel modern | BM25 catches what embeddings structurally cannot |
| Post-filtering by tenant | The store made it easy | Pre-filter, and test it |
| Chunk ids that change per run | Random UUIDs | Content-addressed ids |
| No abstain instruction | Nobody asks for it | A retrieval miss becomes a hallucination without it |
| Tuning before evaluating | Faster to feel progress | Every change after that is a guess |

## References

- `../blueprints/blueprints/rag-baseline.md` — the full pattern
- `../blueprints/blueprints/chunking-strategies.md` — splitting decisions
- `../blueprints/blueprints/hybrid-search-rrf.md` — fusion details
- `../blueprints/blueprints/reranking.md` — second stage
- `../blueprints/blueprints/rag-evaluation.md` — the measurement layer
