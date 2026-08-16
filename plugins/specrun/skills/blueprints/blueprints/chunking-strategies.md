+++
id = "chunking-strategies"
title = "Chunking strategies"
use_when = "Deciding how documents are split before indexing; retrieved chunks are truncated, mix several topics, or lose the structure of the source"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Chunking Strategies

> Splitting documents into the units that get embedded and retrieved. The decision that caps every downstream metric — no reranker recovers information a bad split destroyed.

**Tier:** foundational
**Use when:** always, in any retrieval system.
**Avoid when:** never. "No chunking" (whole documents) is itself a chunking strategy, valid for short documents.
**Cost profile:** indexing-time only. Re-chunking requires a full re-index — get close to right early.

---

## 1. Problem it solves

Embeddings compress a passage into one vector. Too much text per chunk and the vector becomes an average of several topics, matching everything weakly and nothing strongly. Too little and the chunk lacks the context to be understood — "It supports up to 40 concurrent connections" is useless without knowing what *it* is.

The tension is fixed: **retrieval precision wants small chunks; answer completeness wants large ones.** Every strategy below is a different resolution of that tension, and the right one is a property of your documents, not a universal best practice.

## 2. Shape

```
FIXED             │ ████│████│████│████│      ignores structure, splits mid-sentence
RECURSIVE         │ ███│█████│███│██████│     splits on ¶ → sentence → word, respects tokens
STRUCTURAL        │ [# H1][## H2 ][## H3 ]    splits on markdown/HTML/AST boundaries
SEMANTIC          │ ███████│██│█████████│     splits where embedding similarity drops
PARENT-CHILD      │ embed:  ▪ ▪ ▪ ▪ ▪ ▪       small children for matching …
                  │ return: ████████████      … large parent for answering
LATE CHUNKING     │ embed whole doc → pool token vectors per chunk (context preserved)
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Parser | Preserve structure while extracting text | `unstructured`, `pymupdf4llm`, `markdownify` | Flattens headings and tables → structural chunking impossible |
| Splitter | Apply the boundary rule | LangChain/LlamaIndex splitters, custom | Uses character counts instead of tokens |
| Token counter | Enforce real size limits | The embedding model's tokenizer | Characters ≈ tokens is off 3–4×, worse for non-English |
| Metadata attacher | Carry section path, page, doc id | Custom | Lost → citations and filters impossible |
| Overlap manager | Bridge boundary cuts | Custom | Excessive overlap inflates the index and duplicates results |
| Special-content handler | Tables, code, lists | Custom per type | Tables split across chunks become meaningless |

## 4. Data flow

1. Parse to text **plus structure** (heading hierarchy, page numbers, table boundaries, code fences).
2. Route by content type: prose → recursive/structural; tables → row-group serialisation; code → AST-aware.
3. Split, enforcing size in *tokens* of the embedding model.
4. Attach metadata: `section_path`, `page`, `doc_id`, `chunk_index`, `token_count`.
5. Optionally enrich each chunk with context — see [contextual-retrieval.md](contextual-retrieval.md).
6. Emit with content-addressed ids.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal, Protocol

class ChunkingConfig(BaseModel):
    strategy: Literal["fixed", "recursive", "structural", "semantic", "parent_child", "late"]
    target_tokens: int = Field(400, ge=64, le=2048)
    max_tokens: int = Field(512, description="Hard ceiling; must be ≤ embedding model limit")
    overlap_tokens: int = Field(60, ge=0)
    separators: list[str] = ["\n## ", "\n### ", "\n\n", "\n", ". ", " "]
    keep_tables_whole: bool = True
    min_tokens: int = Field(50, description="Below this, merge into the neighbour — tiny chunks are noise")

class Splitter(Protocol):
    def split(self, text: str, meta: dict) -> list[Chunk]: ...
```

## 6. Reference implementation

Recursive splitter with real token counting and structural separators — the correct default.

```python
import tiktoken
enc = tiktoken.get_encoding("cl100k_base")     # use YOUR embedding model's tokenizer

def ntok(s: str) -> int:
    return len(enc.encode(s))

def recursive_split(text: str, cfg: ChunkingConfig, sep_idx: int = 0) -> list[str]:
    if ntok(text) <= cfg.target_tokens:
        return [text]
    if sep_idx >= len(cfg.separators):
        # Last resort: hard token slice.
        toks = enc.encode(text)
        return [enc.decode(toks[i:i + cfg.target_tokens])
                for i in range(0, len(toks), cfg.target_tokens)]

    sep = cfg.separators[sep_idx]
    parts, out, buf = text.split(sep), [], ""
    for p in parts:
        cand = buf + sep + p if buf else p
        if ntok(cand) <= cfg.target_tokens:
            buf = cand
        else:
            if buf:
                out.append(buf)
            buf = p if ntok(p) <= cfg.target_tokens else ""
            if not buf:                       # single part too big → recurse deeper
                out.extend(recursive_split(p, cfg, sep_idx + 1))
    if buf:
        out.append(buf)

    # Merge runts — a 20-token chunk is pure noise in the index.
    merged = []
    for c in out:
        if merged and ntok(c) < cfg.min_tokens:
            merged[-1] += sep + c
        else:
            merged.append(c)
    return merged

def with_overlap(chunks: list[str], cfg: ChunkingConfig) -> list[str]:
    if cfg.overlap_tokens == 0:
        return chunks
    out = []
    for i, c in enumerate(chunks):
        if i == 0:
            out.append(c)
            continue
        tail = enc.decode(enc.encode(chunks[i - 1])[-cfg.overlap_tokens:])
        out.append(tail + "\n" + c)
    return out
```

Structural splitting for markdown — better than recursive whenever headings exist:

```python
import re

def structural_split(md: str, cfg: ChunkingConfig) -> list[tuple[str, list[str]]]:
    """Returns (text, section_path). Heading hierarchy becomes retrievable metadata."""
    out, path, buf = [], [], []
    for line in md.splitlines(keepends=True):
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            if buf:
                out.append(("".join(buf), path.copy()))
                buf = []
            level = len(m.group(1))
            path = path[:level - 1] + [m.group(2).strip()]
            buf.append(line)
        else:
            buf.append(line)
            if ntok("".join(buf)) > cfg.max_tokens:
                out.append(("".join(buf), path.copy()))
                buf = []
    if buf:
        out.append(("".join(buf), path.copy()))
    # Sections that are still too big get recursively split, keeping their path.
    final = []
    for text, p in out:
        for piece in (recursive_split(text, cfg) if ntok(text) > cfg.max_tokens else [text]):
            final.append((piece, p))
    return final
```

Parent–child (small-to-big): embed precise children, return complete parents.

```python
def parent_child(text: str, cfg: ChunkingConfig):
    parents = recursive_split(text, ChunkingConfig(strategy="recursive", target_tokens=1600))
    for pi, parent in enumerate(parents):
        parent_id = f"p{pi}"
        store.put_parent(parent_id, parent)                 # NOT embedded
        for ci, child in enumerate(recursive_split(parent, ChunkingConfig(
                strategy="recursive", target_tokens=200))):
            store.put_child(f"{parent_id}:c{ci}", child, parent_id=parent_id)   # embedded
    # Retrieval: match children → dedupe → fetch and return their parents.
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `target_tokens` | 400 | The core precision/completeness trade | 200–300 for FAQ/support; 600–800 for technical docs and narrative |
| `max_tokens` | 512 | Ceiling | Must not exceed the embedding model's window |
| `overlap_tokens` | 60 (~15%) | Boundary recovery | 0 with structural splitting; up to 25% for dense prose |
| `min_tokens` | 50 | Runt suppression | Raise if the index fills with fragments |
| Separators | headings → ¶ → sentence | Where cuts land | Add domain markers: `\nArticle `, `\nSection `, `\nQ: ` |
| `keep_tables_whole` | true | Table integrity | Always true; split tables by row groups with a repeated header |
| Strategy | recursive | Everything | Structural whenever headings exist — it is strictly better |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Chunk retrieved but unusable ("it supports 40 connections") | Split severed the antecedent | Read 20 random chunks cold | Structural splitting + section path in the chunk, or [contextual retrieval](contextual-retrieval.md) |
| Answer needs two adjacent chunks, only one retrieved | Target size too small | Fraction of gold answers spanning chunks | Raise `target_tokens`, add overlap, or parent–child |
| Table answers always wrong | Table split across chunks | Inspect table chunks | Keep tables whole; serialise as markdown with a repeated header per row group |
| Index has 3× the expected chunks | Overlap too high, or runts not merged | Chunk count vs corpus tokens | Reduce overlap, raise `min_tokens` |
| Retrieval returns 5 near-identical chunks | Overlap duplicates content | Pairwise similarity of results | Deduplicate at retrieval; reduce overlap |
| Chunks exceed the embedding limit and get truncated | Characters counted, not tokens | Assert `token_count ≤ limit` at index time | Use the model's tokenizer |
| Code answers cite the wrong function | Split mid-function | Inspect code chunks | AST-aware splitting; one function/class per chunk with the file path in metadata |
| Non-English corpus chunks are half the intended size | Character heuristic | Token-count distribution by language | Token counting, always |

## 9. Anti-patterns

- **Fixed character-count splitting.** The default in too many tutorials. It splits mid-sentence, mid-table, mid-code, and mis-sizes non-English text.
- **Ignoring document structure.** If the source has headings, using them is free precision and free citation metadata.
- **Massive overlap "for safety".** 50% overlap doubles the index, doubles cost, and floods top-k with near-duplicates.
- **One strategy for all content types.** A corpus of PDFs, code, and spreadsheets needs three routes.
- **Chunking without reading the output.** Print 20 random chunks and read them cold. If *you* cannot tell what they are about, neither can the embedding model.
- **Optimising chunk size before having an eval set.** You cannot tell whether a change helped.
- **Discarding heading hierarchy.** `section_path` is the cheapest quality win in the whole pipeline: it improves both retrieval and citations.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Standalone comprehensibility | Sampled chunks a human understands cold | ≥ 90% | < 70% |
| Chunk token distribution | p5 / p50 / p95 | p50 near target, p5 > `min_tokens` | p95 > `max_tokens` |
| Answer-span rate | Gold answers contained in one chunk | ≥ 85% | < 70% |
| Duplicate rate in top-k | Near-identical retrieved chunks | < 10% | > 25% |
| Index size ratio | Indexed tokens / corpus tokens | 1.1–1.2× | > 1.5× (overlap too high) |
| Recall@10 (as a proxy) | Gold chunk retrieved | ≥ 0.90 | < 0.80 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Recursive, 400 tokens, 15% overlap |
| v1 | Documents have headings | Structural splitting + `section_path` metadata |
| v2 | Chunks lack context standalone | [Contextual retrieval](contextual-retrieval.md): LLM-written context prefix per chunk |
| v3 | Precision and completeness both matter | Parent–child: embed small, return large |
| v4 | Mixed content types | Per-type routing: prose / table / code / slides |
| v5 | Boundary loss is still the dominant error | Late chunking (embed the whole document, pool token vectors per chunk) |

## 12. Build checklist

- [ ] Token counting uses the embedding model's tokenizer, not characters.
- [ ] Document structure (headings, pages) survives parsing and lands in metadata.
- [ ] `section_path` is attached to every chunk.
- [ ] Tables are kept whole or split by row groups with a repeated header.
- [ ] Code is split on AST boundaries with the file path in metadata.
- [ ] Runts below `min_tokens` are merged into neighbours.
- [ ] Every chunk is asserted to be within the embedding model's limit.
- [ ] 20 random chunks were read cold by a human and were comprehensible.
- [ ] Chunk ids are content-addressed and stable.
- [ ] An eval set exists before any chunk-size tuning.

## 13. Related

- [rag-baseline.md](rag-baseline.md) — where chunks are consumed
- [contextual-retrieval.md](contextual-retrieval.md) — fixing standalone comprehensibility directly
- [rag-evaluation.md](rag-evaluation.md) — measuring whether a change helped
- [document-parsing.md](document-parsing.md) — getting clean structured text in the first place
