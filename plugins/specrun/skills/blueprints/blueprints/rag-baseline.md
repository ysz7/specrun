+++
id = "rag-baseline"
title = "RAG baseline"
use_when = "Answers have to come from a document corpus the model was not trained on, the corpus changes, or answers must cite their sources; retrieval is being set up, or the model hallucinates and cannot attribute what it says"
pack = "ai-agents"
verified_at = 2026-08-12
stale_after = "90d"
+++

# RAG Baseline

> Chunk documents, embed them, store the vectors, embed the query, fetch top-k by similarity, put them in the prompt. The starting point every other pattern in this folder modifies.

**Tier:** foundational
**Use when:** the model must answer from a corpus it was not trained on, the corpus changes, or answers must be attributable to sources.
**Avoid when:** the corpus fits comfortably in the context window (then just put it there — retrieval only adds failure modes), or the task needs reasoning over the *whole* corpus rather than a few passages (that is analytics, not RAG).
**Cost profile:** one embedding call per query (~1 ms, ~$0.00001) + k chunks in the prompt (typically 2 000–6 000 tokens). Indexing is a one-time cost per document version.

---

## 1. Problem it solves

Models do not know your documents, hallucinate confidently about them, and cannot cite. Fine-tuning teaches style and format, not facts that change weekly.

RAG converts "what does the model know?" into "what did we put in the prompt?" — a question you can debug, measure, and fix. The failure modes move from opaque (the model is wrong) to inspectable (the right chunk was not retrieved / was retrieved and ignored).

**Before building this, check:** if the whole corpus is under ~100k tokens and changes rarely, put it in the prompt with caching. It will beat any RAG system you build this quarter, on both quality and effort.

## 2. Shape

```
INDEXING (offline, per document version)
  documents ─▶ parse ─▶ chunk ─▶ embed ─▶ ┌──────────────┐
                          │                │ vector store │
                          └─ metadata ────▶│ + payload    │
                                           └──────────────┘
QUERY (online, per request)
  query ─▶ embed ─▶ ANN search top-k ─▶ chunks ─▶ prompt assembly ─▶ LLM ─▶ answer
                          │                                                   │
                          └── metadata filter (tenant, date, doc type)        └─▶ citations
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Parser | Bytes → clean text + structure | `unstructured`, `pymupdf`, vendor doc APIs | Tables and layout destroyed → chunks are gibberish |
| Chunker | Text → retrievable units | Recursive splitter, structural splitter | Splits mid-thought; answer spans two chunks |
| Embedder | Text → vector | Provider embedding API, open models | Query and document embedded with different models/prefixes |
| Vector store | ANN index + metadata filter + payload | pgvector, Qdrant, Weaviate, Pinecone, LanceDB | Filter applied after ANN → fewer than k results |
| Retriever | Query → top-k chunks | Store client | Fixed k regardless of query difficulty |
| Prompt assembler | Chunks → context block | Template | No source markers → no citations possible |
| Generator | Chunks + question → answer | LLM | Answers from parametric knowledge when chunks are irrelevant |

## 4. Data flow

**Index:** document → parse to text + structure → chunk (with metadata: `doc_id`, `section`, `page`, `updated_at`, `tenant_id`) → embed each chunk → upsert by a **stable chunk id** so re-indexing replaces rather than duplicates.

**Query:** query text → embed with the *same model and the query-side prefix* → ANN search with metadata pre-filter → top-k chunks → assemble a delimited context block with source ids → LLM with an instruction to answer only from context and cite → return answer + sources.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from datetime import datetime

class Chunk(BaseModel):
    id: str = Field(description="Stable: sha256(doc_id + chunk_index + text). Enables idempotent upsert.")
    doc_id: str
    tenant_id: str                     # enforced as a pre-filter, never post-filter
    text: str
    embedding: list[float] | None = None
    # Metadata is not decoration — it is how you filter, cite, and debug.
    source_uri: str
    section_path: list[str] = Field(default_factory=list, description="['Chapter 2', 'Billing']")
    page: int | None = None
    chunk_index: int
    token_count: int
    updated_at: datetime
    content_hash: str                  # skip re-embedding unchanged chunks

class RetrievalResult(BaseModel):
    chunk: Chunk
    score: float
    rank: int

class RAGAnswer(BaseModel):
    answer: str
    sources: list[str] = Field(description="chunk ids actually cited, not merely retrieved")
    retrieved: list[RetrievalResult]
    abstained: bool = False
```

## 6. Reference implementation

```python
import hashlib, textwrap
from anthropic import Anthropic

client = Anthropic()

# ---------- index ----------
def index_document(doc_id: str, text: str, meta: dict, store, embedder):
    chunks = chunk_text(text, target_tokens=400, overlap_tokens=60)   # see chunking-strategies.md
    records = []
    for i, c in enumerate(chunks):
        h = hashlib.sha256(c.encode()).hexdigest()[:16]
        cid = f"{doc_id}::{i}::{h}"
        if store.exists(cid):            # content unchanged → skip the embedding cost
            continue
        records.append(Chunk(id=cid, doc_id=doc_id, text=c, chunk_index=i,
                             content_hash=h, token_count=count_tokens(c), **meta))
    if records:
        vectors = embedder.embed_documents([r.text for r in records])   # document-side prefix
        store.upsert(records, vectors)
    store.delete_where(doc_id=doc_id, id_not_in=[r.id for r in records])  # drop stale chunks

# ---------- query ----------
SYSTEM = """Answer using ONLY the context below.

Rules:
- Cite the source id in brackets after each claim, like [doc-42::3::a1b2].
- If the context does not contain the answer, say exactly: "The provided context does not
  contain this information." Do not answer from your own knowledge.
- If sources contradict each other, say so and cite both."""

def answer(question: str, tenant_id: str, store, embedder, k: int = 8) -> RAGAnswer:
    qvec = embedder.embed_query(question)          # query-side prefix — NOT the document one
    hits = store.search(qvec, top_k=k, filter={"tenant_id": tenant_id})   # PRE-filter

    if not hits:
        return RAGAnswer(answer="The provided context does not contain this information.",
                         sources=[], retrieved=[], abstained=True)

    context = "\n\n".join(
        f"<source id=\"{h.chunk.id}\" uri=\"{h.chunk.source_uri}\" "
        f"section=\"{' > '.join(h.chunk.section_path)}\">\n{h.chunk.text}\n</source>"
        for h in hits)

    resp = client.messages.create(
        model="<MODEL_ID>", max_tokens=1500, temperature=0,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"<context>\n{context}\n</context>\n\nQuestion: {question}"}])
    text = resp.content[0].text
    return RAGAnswer(answer=text,
                     sources=[h.chunk.id for h in hits if h.chunk.id in text],
                     retrieved=hits,
                     abstained="does not contain this information" in text)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Chunk size | 300–500 tokens | Precision vs completeness | See [chunking-strategies.md](chunking-strategies.md) |
| Overlap | 10–15% | Boundary loss | Raise when answers span chunk edges |
| `k` | 5–10 | Recall vs noise vs cost | Raise k *and* add a [reranker](reranking.md) rather than raising k alone |
| Embedding model | provider default | Everything | Changing it requires a full re-index — decide early |
| Distance metric | cosine | Match to the model's training | Follow the model card; do not guess |
| Metadata filter | pre-filter | Correctness of tenancy | **Always** pre-filter; post-filtering silently returns < k |
| Temperature | 0 | Faithfulness | Always 0 for extractive answering |
| Abstain instruction | on | Hallucination rate | Never remove it |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Answer is wrong, chunk was correct | Generation ignored the context | Manual: is the answer in the retrieved chunks? | Stronger abstain instruction, lower k (less noise), better source delimiters |
| Answer is wrong, chunk was missing | Retrieval failure | recall@k on a labelled set | [Hybrid search](hybrid-search-rrf.md), better [chunking](chunking-strategies.md), [query transformation](query-transformation.md) |
| Exact terms (`ERR_4021`, SKU) never found | Dense embeddings are bad at rare literals | Test with identifier queries | Add BM25 → [hybrid-search-rrf.md](hybrid-search-rrf.md) |
| Chunk is relevant but unusable | Split lost the surrounding context | Read the retrieved chunks | [Contextual retrieval](contextual-retrieval.md) |
| Cross-tenant data returned | Filter applied after ANN, or not at all | Two-tenant test in CI | Pre-filter in the ANN query; enforce in the store |
| Quality decayed over weeks | Stale index; deletes never propagated | Index freshness metric | Incremental sync with tombstones |
| Table data always wrong | Parser flattened the table | Inspect parsed text | Structure-aware parsing; serialise tables as markdown per row |
| Retrieval good, answer generic | Too many chunks diluted attention | Vary k, measure | Lower k + [rerank](reranking.md) to raise precision |
| Same doc dominates all k slots | Near-duplicate chunks | Inspect source diversity | MMR / per-document cap |

## 9. Anti-patterns

- **Building RAG when the corpus fits in context.** Prompt caching over 80k tokens of docs beats a mediocre retriever on quality and takes an afternoon.
- **Different embedding models (or prefixes) for query and document.** Silently destroys relevance. Many models require asymmetric prefixes — read the model card.
- **Post-filtering by metadata.** Fetch 10, filter to 2. You asked for 10 and got 2, and no error was raised.
- **Chunk ids that change every re-index.** You cannot deduplicate, cannot cite stably, and the index grows forever.
- **No abstain path.** Without "say when you don't know", a retrieval miss becomes a hallucination.
- **Tuning k by feel.** Measure recall@k and precision@k on a labelled set. k=20 without a reranker usually makes answers *worse*.
- **Shipping without an eval set.** Every change after that is a guess. Build 50 labelled Q→chunk pairs first.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Recall@k | Gold chunk in top-k | ≥ 0.90 | < 0.80 |
| Precision@5 | Retrieved chunks that are relevant | ≥ 0.60 | < 0.40 |
| Faithfulness | Claims supported by retrieved context | ≥ 0.95 | < 0.90 |
| Answer relevance | Answer addresses the question | ≥ 0.90 | < 0.85 |
| Abstain accuracy | Correct abstentions / should-abstain | ≥ 0.85 | < 0.70 |
| Retrieval latency p95 | Embed + ANN | < 200 ms | > 500 ms |
| Index freshness | Time from source change to searchable | < 15 min | > 2 h |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Fixed chunking, dense-only, k=5, no eval |
| v1 | Any change is a guess | Labelled eval set (50+ Q→chunk), recall@k measured |
| v2 | Exact-term queries fail | [Hybrid BM25 + dense with RRF](hybrid-search-rrf.md) |
| v3 | Precision@5 lags recall@50 | [Cross-encoder reranker](reranking.md) |
| v4 | Chunks lack context | [Contextual retrieval](contextual-retrieval.md) |
| v5 | Multi-hop / vague queries | [Query transformation](query-transformation.md), then [agentic RAG](agentic-rag.md) |
| v6 | Relationship questions | [GraphRAG](graph-rag.md) |

## 12. Build checklist

- [ ] Verified the corpus does not simply fit in context.
- [ ] Query and document use the same embedding model with the correct asymmetric prefixes.
- [ ] Chunk ids are content-addressed and stable across re-indexing.
- [ ] Metadata includes tenant, source uri, section path, page, and `updated_at`.
- [ ] Tenant filtering is a pre-filter in the ANN query, tested with two tenants.
- [ ] Deleted source documents remove their chunks (tombstones or delete-by-doc_id).
- [ ] The prompt delimits sources with ids and demands citations.
- [ ] An explicit abstain instruction exists and is tested.
- [ ] Temperature is 0.
- [ ] A labelled eval set of ≥ 50 question→gold-chunk pairs runs in CI.
- [ ] recall@k, precision@5, and faithfulness are all tracked.

## 13. Related

- [chunking-strategies.md](chunking-strategies.md) — the highest-leverage indexing decision
- [hybrid-search-rrf.md](hybrid-search-rrf.md) — the first upgrade almost everyone needs
- [reranking.md](reranking.md) — turning recall into precision
- [rag-evaluation.md](rag-evaluation.md) — build this before v1
- [vector-store-selection.md](vector-store-selection.md) — picking the store
- [../../Data Pipelines/architecture/ingestion-pipeline.md](../data/ingestion-pipeline.md) — the indexing side at scale
