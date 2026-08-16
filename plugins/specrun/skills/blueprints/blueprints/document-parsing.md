+++
id = "document-parsing"
title = "Document parsing"
use_when = "Inputs are PDFs, Office files, HTML or scans and have to become clean text that keeps headings, tables, reading order and page provenance"
pack = "data pipelines"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Document Parsing

> Turning PDFs, Office files, HTML, and images into clean text that preserves the structure downstream stages depend on — headings, tables, reading order, and page provenance.

**Tier:** foundational
**Use when:** any pipeline whose inputs are not already clean text.
**Avoid when:** sources are already structured (JSON, database rows, markdown). Do not parse what is already parsed.
**Cost profile:** free for text formats; seconds per page and real money for OCR or vision-model parsing of scanned documents.

---

## 1. Problem it solves

Parsing is where retrieval quality is silently capped. A parser that flattens a PDF into a wall of text destroys the heading hierarchy that [structural chunking](chunking-strategies.md) needs, scrambles multi-column reading order, and turns tables into unusable token soup. Every downstream stage then operates on damaged input, and no reranker recovers it.

The trap is that parsing *appears* to work. `pdf.extract_text()` returns text. It is only when someone reads a retrieved chunk and finds an interleaved two-column paragraph that the real cost surfaces.

**The rule: look at the parser output before building anything on top of it.** Print ten parsed documents and read them.

## 2. Shape

```
   input ──▶ ┌──────────────┐
             │ type detect  │  magic bytes, not the file extension
             └──────┬───────┘
        ┌───────────┼───────────┬──────────────┬──────────────┐
        ▼           ▼           ▼              ▼              ▼
   ┌────────┐  ┌────────┐  ┌────────┐    ┌─────────┐   ┌──────────┐
   │ text/  │  │ HTML   │  │ Office │    │ PDF     │   │ image /  │
   │ md     │  │        │  │ docx/  │    │         │   │ scanned  │
   │        │  │ strip  │  │ xlsx/  │    │ digital?│   │          │
   │ pass   │  │ nav,   │  │ pptx   │    │  ├ yes →│   │ OCR or   │
   │ through│  │ ads    │  │        │    │  │ text │   │ vision   │
   └────────┘  └────────┘  └────────┘    │  └ no ─→│   │ model    │
                                          └─────────┘   └──────────┘
        └───────────┴───────────┴──────────────┴──────────────┘
                                │
                                ▼
              ┌──────────────────────────────────┐
              │ NORMALISED DOCUMENT              │
              │  markdown text                   │
              │  + heading hierarchy             │
              │  + tables as markdown            │
              │  + page/section provenance       │
              │  + parse quality score           │
              └──────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Type detector | Identify the real format | `python-magic`, magic bytes | Trusting the file extension |
| PDF text extractor | Digital PDFs → text + layout | `pymupdf`, `pdfplumber`, `pymupdf4llm` | Multi-column reading order scrambled |
| OCR | Scanned pages → text | Tesseract, cloud OCR, vision models | Applied to digital PDFs (slow, worse) |
| Table extractor | Preserve tabular structure | `camelot`, `pdfplumber`, vision models | Tables flattened into prose |
| Office readers | docx/xlsx/pptx | `python-docx`, `openpyxl`, `python-pptx` | Speaker notes and comments dropped |
| HTML cleaner | Content vs chrome | `trafilatura`, `readability` | Navigation and footers kept as content |
| Normaliser | One output shape | Markdown + metadata | Each format emits a different shape |
| Quality scorer | Detect bad parses automatically | Heuristics | Absent → garbage indexed silently |

## 4. Data flow

1. Detect the true type from magic bytes.
2. Route to the format handler.
3. For PDFs, decide digital vs scanned: if extractable text covers a reasonable fraction of the page area, it is digital. **Only fall back to OCR when it is not** — OCR on a digital PDF is slower and less accurate.
4. Extract text **with structure**: headings, lists, tables, reading order.
5. Normalise to markdown: `#` headings, `|` tables, fenced code.
6. Attach provenance: page number, section path, bounding boxes if available.
7. **Score parse quality.** Below threshold → quarantine for review rather than indexing.
8. Emit a uniform document object regardless of input format.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class ParsedBlock(BaseModel):
    kind: Literal["heading", "paragraph", "table", "list", "code", "caption"]
    level: int | None = None                  # heading depth
    text: str
    page: int | None = None
    section_path: list[str] = Field(default_factory=list)

class ParsedDocument(BaseModel):
    source_id: str
    mime_type: str
    text_markdown: str = Field(description="Normalised. Headings as #, tables as | pipes.")
    blocks: list[ParsedBlock]
    page_count: int | None = None
    parse_method: str = Field(description="'pymupdf' | 'ocr:tesseract' | 'vision' | ...")
    quality_score: float = Field(ge=0, le=1, description="< 0.5 → quarantine, do not index")
    warnings: list[str] = Field(default_factory=list)

class ParseConfig(BaseModel):
    ocr_threshold_chars_per_page: int = Field(
        100, description="Below this, treat the page as scanned")
    quality_threshold: float = 0.5
    max_pages: int = 500
    preserve_tables: bool = True
    strip_html_chrome: bool = True
```

## 6. Reference implementation

```python
import re, magic, pymupdf, pymupdf4llm

def detect_type(content: bytes, filename: str) -> str:
    """Magic bytes, not the extension. Users rename files; extensions lie."""
    return magic.from_buffer(content[:2048], mime=True)

def parse_pdf(content: bytes, cfg: ParseConfig) -> ParsedDocument:
    doc = pymupdf.open(stream=content, filetype="pdf")
    if doc.page_count > cfg.max_pages:
        raise ValueError(f"{doc.page_count} pages exceeds limit {cfg.max_pages}")

    # Digital or scanned? Measure, don't guess.
    sample = min(5, doc.page_count)
    chars = sum(len(doc[i].get_text().strip()) for i in range(sample)) / sample

    if chars >= cfg.ocr_threshold_chars_per_page:
        # Digital: markdown extraction preserves headings, tables, and reading order.
        md = pymupdf4llm.to_markdown(doc, page_chunks=False)
        method = "pymupdf4llm"
    else:
        md = ocr_pages(doc)          # Tesseract or a vision model
        method = "ocr"

    return ParsedDocument(
        source_id="", mime_type="application/pdf", text_markdown=md,
        blocks=blocks_from_markdown(md), page_count=doc.page_count,
        parse_method=method, quality_score=score_parse(md, doc.page_count),
        warnings=collect_warnings(md))

def score_parse(text: str, pages: int | None) -> float:
    """Cheap heuristics that catch most catastrophic parses. Not a quality metric —
    a garbage detector."""
    if not text.strip():
        return 0.0
    score = 1.0
    words = text.split()

    # Ligature and encoding damage
    if len(re.findall(r"[�\x00-\x08]", text)) > len(text) * 0.001:
        score -= 0.3
    # Column interleaving usually produces many very short "lines"
    lines = [l for l in text.splitlines() if l.strip()]
    if lines and sum(len(l) < 15 for l in lines) / len(lines) > 0.5:
        score -= 0.25
    # Whitespace explosion from bad layout handling
    if text.count("  ") > len(text) * 0.05:
        score -= 0.15
    # Suspiciously little text per page
    if pages and len(words) / pages < 20:
        score -= 0.3
    # No structure at all in a long document
    if len(words) > 2000 and not re.search(r"^#{1,6} ", text, re.M):
        score -= 0.1
    return max(0.0, score)

def parse_html(content: bytes, cfg: ParseConfig) -> ParsedDocument:
    import trafilatura
    # Extracts the main content and drops nav, ads, and footers — which otherwise
    # become the most-repeated text in your entire index.
    md = trafilatura.extract(content.decode("utf-8", "replace"),
                             output_format="markdown", include_tables=True,
                             include_comments=False) or ""
    return ParsedDocument(source_id="", mime_type="text/html", text_markdown=md,
                          blocks=blocks_from_markdown(md), parse_method="trafilatura",
                          quality_score=score_parse(md, None))
```

Tables — the stage most often quietly broken:

```python
def table_to_markdown(rows: list[list[str]], caption: str | None = None) -> str:
    """A table split across chunks is meaningless. Emit markdown, and if it is long,
    split by ROW GROUPS with the header repeated in each."""
    if not rows:
        return ""
    header, body = rows[0], rows[1:]
    head = "| " + " | ".join(header) + " |\n|" + "---|" * len(header)
    lines = ["| " + " | ".join(str(c) for c in r) + " |" for r in body]
    prefix = f"**{caption}**\n\n" if caption else ""
    return prefix + head + "\n" + "\n".join(lines)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| OCR threshold | 100 chars/page | Digital vs scanned routing | Tune on your corpus; sample and check |
| Quality threshold | 0.5 | What gets quarantined | Raise if bad parses reach the index |
| `max_pages` | 500 | Cost and timeout bound | Raise for a book corpus, with a longer timeout |
| Table handling | markdown, whole | Table usability | Row-group splitting with a repeated header for long tables |
| HTML extraction | main content only | Index noise | Always strip chrome |
| OCR engine | local Tesseract | Cost vs accuracy | Cloud OCR or vision models for hard scans |
| Vision fallback | off | Cost | On for complex layouts where text extraction scores low |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Retrieved chunks are interleaved nonsense | Multi-column reading order | Read parsed output | Layout-aware extraction; vision fallback |
| Tables produce wrong answers | Flattened into prose | Inspect table chunks | Markdown tables; row-group splitting |
| Every document contains the same nav text | HTML chrome not stripped | Most-frequent n-grams across the corpus | `trafilatura`/readability extraction |
| OCR is slow and worse than expected | Applied to digital PDFs | `parse_method` distribution | Measure text density before choosing OCR |
| Encoding artefacts (`ï¬`, `�`) | Ligature and encoding handling | Character-class scan | Normalise ligatures; explicit encoding |
| Structural chunking finds no headings | Parser flattened structure | Heading count per document | Markdown-preserving extraction |
| Wrong parser used | Extension trusted | Type-detection audit | Magic bytes |
| Garbage silently indexed | No quality scoring | Read random chunks | Score every parse; quarantine below threshold |
| Slide decks lose their content | Speaker notes ignored | Compare deck text to reality | Extract notes and text frames |

## 9. Anti-patterns

- **Not reading the parser output.** The most expensive mistake in the pipeline, and the easiest to avoid.
- **`pdf.extract_text()` as the whole strategy.** It loses layout, headings, tables, and reading order.
- **OCR everything.** Slower and *less* accurate than text extraction on digital PDFs.
- **Trusting file extensions.** Detect from content.
- **Indexing raw HTML.** Navigation and footers become the most common text in the corpus.
- **Flattening tables.** A table without its structure answers nothing.
- **No quality scoring.** Bad parses are invisible until users complain.
- **One parser for every format.** Each format needs its own handler and its own failure mode.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Parse success rate | Documents parsed without error | > 98% | < 95% |
| Quality score p10 | 10th percentile of parse quality | > 0.6 | < 0.4 |
| Quarantine rate | Documents below threshold | < 2% | > 10% |
| Heading extraction rate | Documents with detected structure | > 80% (structured corpora) | < 50% |
| OCR share | Documents routed to OCR | matches the scanned share | 2× expected (misrouting) |
| Parse latency p95 | Per document | < 5 s | > 30 s |
| Human-verified quality | Sampled parses read and judged usable | ≥ 95% | < 85% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Plain text extraction |
| v1 | Structure lost | Markdown-preserving extraction with headings |
| v2 | Bad parses reach the index | Quality scoring + quarantine |
| v3 | Scanned documents appear | Text-density routing to OCR |
| v4 | Complex layouts persist | Vision-model parsing for low-scoring documents |
| v5 | Many formats | Per-format handlers, uniform output contract, per-format metrics |

## 12. Build checklist

- [ ] Ten parsed documents were printed and read by a human before building on top.
- [ ] File type detected from magic bytes, not the extension.
- [ ] PDFs routed to OCR only after measuring text density.
- [ ] Extraction preserves heading hierarchy as markdown.
- [ ] Tables emitted as markdown; long tables split by row groups with a repeated header.
- [ ] HTML stripped of navigation, ads, and footers.
- [ ] Page and section provenance attached to every block.
- [ ] A quality score is computed for every parse.
- [ ] Documents below threshold are quarantined, not indexed.
- [ ] Every format has its own handler and emits the same output contract.
- [ ] Parse method and warnings are recorded per document.

## 13. Related

- [ingestion-pipeline.md](ingestion-pipeline.md) — where parsing sits and how it fails safely
- [chunking-strategies.md](chunking-strategies.md) — the consumer of the structure preserved here
- [embedding-pipeline.md](embedding-pipeline.md) — the next stage
- [data-quality-and-pii.md](data-quality-and-pii.md) — validation and redaction after parsing
