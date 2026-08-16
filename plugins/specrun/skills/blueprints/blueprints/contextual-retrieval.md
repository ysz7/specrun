+++
id = "contextual-retrieval"
title = "Contextual retrieval"
use_when = "Retrieved chunks are relevant but unusable on their own — pronouns without antecedents, numbers without units, sections without a subject"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Contextual Retrieval

> Prepending a short, LLM-generated description of each chunk's place in its document *before* embedding it, so the chunk carries the context that splitting removed.

**Tier:** intermediate
**Use when:** retrieved chunks are relevant but unusable standalone — pronouns without antecedents, figures without units, sections without a subject.
**Avoid when:** chunks are already self-contained (structured records, FAQ pairs, log lines), or the corpus is large and volatile enough that an LLM call per chunk is prohibitive.
**Cost profile:** one cheap LLM call per chunk at index time. With prompt caching over the document, roughly $1–2 per million chunk-tokens. Typical retrieval-failure reduction: 30–50%.

---

## 1. Problem it solves

Chunking destroys context by construction. A chunk reading

> "It supports up to 40 concurrent connections, after which requests are queued."

is a perfectly good passage that no embedding can place. What is "it"? Which product, which version, which tier? The vector encodes "concurrency limits" generically, and the chunk loses to a dozen near-identical passages from other products.

The fix is not smaller chunks (worse) or bigger chunks (dilutes the vector). It is to restore the missing context *into the text that gets embedded*, while keeping the chunk small.

Note the ordering benefit: this also fixes lexical search. A chunk prefixed with "Acme Gateway v3, Rate Limits section" now matches a BM25 query for `Acme Gateway rate limit`, which it previously could not.

## 2. Shape

```
                          ┌──────────────────────────────────────┐
  full document ─────────▶│  LLM (cached prefix = whole doc)     │
       │                  │  "Situate this chunk in the doc.     │
       │                  │   50-100 tokens. Succinct."          │
       │  each chunk ────▶└─────────────────┬────────────────────┘
       │                                    │ context sentence
       ▼                                    ▼
   raw chunk  ────────────────────▶  [context] + [raw chunk]
                                            │
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                        embed → dense index         index → BM25
                              │                           │
                              └──────── both improve ─────┘

  At answer time you may show either the contextualised or the raw chunk;
  the context is primarily an *indexing* device.
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Context generator | Write 1–2 sentences situating the chunk | Cheap/fast LLM | Summarises the chunk instead of situating it |
| Prompt cache | Reuse the document prefix across its chunks | Provider caching | Not used → 10–20× the cost |
| Assembler | `context + "\n\n" + chunk` | Trivial | Context stored in metadata but not embedded — no effect |
| Dual indexer | Feed the contextualised text to both dense and BM25 | Pipeline | Only the dense branch updated |
| Cost governor | Cap spend on large corpora | Batching + budget | Absent → surprise bill |
| Fallback | Behaviour when generation fails | Use structural context | Absent → chunk dropped from the index |

## 4. Data flow

**Index time:**
1. Parse and chunk the document as usual.
2. For each chunk, call the LLM with the **whole document as a cached prefix** plus the chunk, asking for a 50–100 token situating context.
3. On failure, fall back to a deterministic context built from metadata: `"{doc_title} > {section_path}. "`.
4. Embed `context + "\n\n" + chunk_text` and index the same string in BM25.
5. Store `raw_text` and `contextualised_text` separately — you may want to show the raw text to the LLM at answer time.

**Query time:** unchanged. This is entirely an indexing-side technique, which is why it composes cleanly with [hybrid search](hybrid-search-rrf.md) and [reranking](reranking.md).

## 5. Contracts

```python
from pydantic import BaseModel, Field

class ContextualChunk(BaseModel):
    id: str
    raw_text: str
    context: str = Field(max_length=600, description="1-2 sentences situating the chunk.")
    contextualised_text: str = Field(description="context + '\\n\\n' + raw_text. THIS is what gets embedded.")
    context_source: str = Field(description="'llm' | 'structural-fallback'")
    doc_id: str
    section_path: list[str]

class ContextConfig(BaseModel):
    model: str = "<FAST_MODEL_ID>"
    max_context_tokens: int = 100
    max_doc_tokens: int = Field(150_000, description="Above this, use section-level context instead of whole-doc")
    batch_size: int = 32
    fallback_on_error: bool = True
```

## 6. Reference implementation

```python
from anthropic import Anthropic
import asyncio

client = Anthropic()

CONTEXT_PROMPT = """<document>
{document}
</document>

Here is a chunk from that document:
<chunk>
{chunk}
</chunk>

Write 1-2 short sentences that situate this chunk within the document, so it can be
understood and found on its own.

Include: what the document is, which section this is from, and what specific thing this
chunk is about (resolve any pronouns and vague references).
Do NOT summarise the chunk's content. Do NOT add commentary.
Answer with the context sentences only."""

async def contextualise(document: str, chunks: list[Chunk],
                        cfg: ContextConfig) -> list[ContextualChunk]:
    async def one(chunk: Chunk) -> ContextualChunk:
        try:
            resp = await client.messages.create(
                model=cfg.model, max_tokens=cfg.max_context_tokens, temperature=0,
                messages=[{"role": "user", "content": [
                    # The document is the cached prefix — this is what makes it affordable.
                    {"type": "text", "text": CONTEXT_PROMPT.split("<chunk>")[0]
                                             .format(document=document),
                     "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": f"<chunk>\n{chunk.text}\n</chunk>\n\n"
                                             + CONTEXT_PROMPT.split("</chunk>")[1]},
                ]}])
            ctx, src = resp.content[0].text.strip(), "llm"
        except Exception:
            if not cfg.fallback_on_error:
                raise
            ctx = f"From '{chunk.doc_title}', section {' > '.join(chunk.section_path)}."
            src = "structural-fallback"

        return ContextualChunk(
            id=chunk.id, raw_text=chunk.text, context=ctx,
            contextualised_text=f"{ctx}\n\n{chunk.text}",
            context_source=src, doc_id=chunk.doc_id, section_path=chunk.section_path)

    sem = asyncio.Semaphore(cfg.batch_size)
    async def bounded(c):
        async with sem:
            return await one(c)
    return await asyncio.gather(*[bounded(c) for c in chunks])

def index(cchunks: list[ContextualChunk], vector_store, bm25_index, embedder):
    texts = [c.contextualised_text for c in cchunks]      # BOTH indices get the same text
    vector_store.upsert(cchunks, embedder.embed_documents(texts))
    bm25_index.upsert([(c.id, t) for c, t in zip(cchunks, texts)])
```

**Zero-cost variant.** Before spending on LLM calls, try the structural context alone — it captures a large share of the benefit for free:

```python
context = f"{doc_title} — {' > '.join(section_path)} ({doc_type}, updated {updated_at:%Y-%m}). "
```

Measure this first. If it closes most of the gap, stop here.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Context length | 50–100 tokens | Signal vs dilution | Longer contexts start to dominate the chunk's own vector |
| Generation model | fast/cheap tier | Cost | The frontier model is not needed for one situating sentence |
| Doc size cap | 150k tokens | Prompt-cache viability | Above it, pass the enclosing section instead of the whole document |
| Prompt caching | on | Cost | Never off — it is the difference between viable and not |
| Fallback | structural | Robustness | Always on |
| Concurrency | 32 | Index throughput | Match the provider quota |
| Re-contextualise on edit | changed chunks only | Cost | Content-hash comparison, not blanket re-run |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| No retrieval improvement | Context stored but not embedded | Inspect the indexed text | Embed `contextualised_text`, not `raw_text` |
| Retrieval got *worse* | Context too long; it dominates the vector | Context/chunk token ratio | Cap at 100 tokens; ratio should stay < 0.3 |
| Every chunk gets a near-identical context | Prompt asked for a document summary | Read 20 generated contexts | "Situate this chunk", not "summarise the document" |
| Indexing cost 20× expected | Prompt caching not engaged | Cache-hit metrics on index runs | Put the document in a cached block; process a document's chunks together |
| Contexts contain hallucinated facts | Model embellished | Sample-audit | Temperature 0, "do not add commentary", short cap |
| BM25 unchanged | Only the dense index updated | Compare indexed strings | Feed the same text to both |
| Answers cite context sentences as source text | Contextualised text sent to the LLM | Read answers | Send `raw_text` at answer time; context is for indexing |

## 9. Anti-patterns

- **Contextualising without prompt caching.** Re-sending the document per chunk is 10–20× the cost for identical output.
- **Embedding the raw chunk while storing the context in metadata.** A no-op. The context must be inside the embedded string.
- **Long contexts.** A 300-token context on a 400-token chunk means you are largely embedding the context.
- **Summarising instead of situating.** A summary duplicates the chunk's own signal; a situating sentence adds what is missing.
- **Skipping the free structural baseline.** `doc_title > section_path` is zero-cost and often captures most of the gain. Measure it before paying.
- **Re-contextualising the whole corpus on every edit.** Compare content hashes; process only what changed.
- **Applying it to already self-contained chunks.** FAQ pairs and structured records gain nothing.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Retrieval failure reduction | (fail_before − fail_after) / fail_before | ≥ 30% | ≤ 10% (not worth the cost) |
| Recall@20 lift | vs the same pipeline without context | ≥ +5 pts | ≤ +2 pts |
| Context/chunk token ratio | mean | 0.1–0.3 | > 0.5 |
| Fallback rate | structural fallback used | < 2% | > 10% |
| Index cost per 1k chunks | USD | < $2 | > $10 (caching is broken) |
| Standalone comprehensibility | Sampled contextualised chunks understood cold | ≥ 95% | < 85% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Raw chunks |
| v1 | Chunks unusable standalone | Free structural context: `doc_title > section_path` |
| v2 | Structural context insufficient | LLM-generated context with document prompt caching |
| v3 | Documents exceed the cache window | Section-level context instead of whole-document |
| v4 | Corpus is large and volatile | Content-hash-gated incremental re-contextualisation |

## 12. Build checklist

- [ ] The free structural baseline was measured before paying for LLM contexts.
- [ ] `contextualised_text` — not `raw_text` — is what gets embedded.
- [ ] The same contextualised string is indexed in both dense and BM25.
- [ ] The document sits in a cached prompt block; a document's chunks are processed together.
- [ ] Context is capped at ~100 tokens; the context/chunk ratio is monitored.
- [ ] The prompt says "situate", not "summarise", and forbids commentary.
- [ ] A structural fallback handles generation failures.
- [ ] `raw_text` is preserved and is what the answering LLM sees.
- [ ] Re-contextualisation is gated on content-hash changes.
- [ ] Recall lift over the no-context baseline is measured on an eval set.

## 13. Related

- [chunking-strategies.md](chunking-strategies.md) — the problem this compensates for
- [hybrid-search-rrf.md](hybrid-search-rrf.md) — contextualisation improves both branches
- [rag-evaluation.md](rag-evaluation.md) — proving the lift
- [prompt-caching.md](prompt-caching.md) — the mechanism that makes this affordable
