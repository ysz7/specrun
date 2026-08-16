+++
id = "graph-rag"
title = "GraphRAG"
use_when = "Questions are about relationships between entities, or need aggregating across the whole corpus, which independent chunk retrieval structurally cannot answer"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# GraphRAG

> Extracting entities and relationships from the corpus into a graph, then retrieving connected subgraphs (and community summaries) instead of, or alongside, independent text chunks.

**Tier:** advanced
**Use when:** questions are about *relationships* ("who reports to whom", "which components depend on this service", "how are these two papers connected") or require aggregating across the whole corpus ("what are the main themes"), which vector search structurally cannot do.
**Avoid when:** questions are lookups answerable by one passage. GraphRAG costs 10–100× more to index and adds a whole extraction pipeline to maintain. Most RAG systems do not need it.
**Cost profile:** indexing is expensive — 1–2 LLM calls per chunk for extraction, plus community summarisation. Query cost is comparable to normal RAG.

---

## 1. Problem it solves

Vector search retrieves passages *independently by similarity*. Two failures follow directly:

1. **Multi-hop relationships.** "Which of Acme's subsidiaries operate in regulated markets?" needs the subsidiary list from document A joined to regulatory status from documents B–F. No single chunk contains the answer, and similarity search cannot traverse.
2. **Global questions.** "What are the recurring complaints in these 4 000 support tickets?" requires aggregation over the corpus. Top-10 chunks are a sample, not a summary.

A graph makes relationships first-class: entities are nodes, relationships are edges, and hierarchical community summaries answer global questions from pre-computed aggregates.

**Cheaper alternatives to try first:** [agentic RAG](agentic-rag.md) handles many multi-hop questions by searching twice; a metadata filter handles many "which X are Y" questions. Try both before building an extraction pipeline.

## 2. Shape

```
INDEXING (expensive, offline)
  chunks ─▶ LLM entity+relation extraction ─▶ ┌──────────────────┐
                                              │  entities, edges │
                     ┌────────────────────────┤  claims          │
                     │                        └──────────────────┘
                     ▼                                 │
            community detection                        │
            (Leiden, hierarchical)                     │
                     │                                 │
                     ▼                                 ▼
        ┌──────────────────────────┐        ┌────────────────────┐
        │ community summaries      │        │ graph store        │
        │ (L0 broad → L2 narrow)   │        │ + vector index on  │
        └──────────────────────────┘        │   node/edge text   │
                                            └────────────────────┘
QUERY
  LOCAL  : find seed entities ─▶ expand 1-2 hops ─▶ subgraph + source chunks ─▶ LLM
  GLOBAL : map over community summaries ─▶ reduce to one answer ─▶ LLM
  HYBRID : vector top-k ∪ graph neighbourhood ─▶ RRF ─▶ rerank ─▶ LLM
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Entity extractor | Chunk → typed entities | LLM with a fixed type list | Open-ended types → 400 synonymous entity types |
| Relation extractor | Chunk → typed edges with evidence | Same LLM call | Edges with no source chunk → unverifiable claims |
| Entity resolver | Merge "Acme Corp" / "ACME" / "Acme Corporation" | Embedding + string similarity + LLM tiebreak | Absent → the graph fragments into duplicates |
| Graph store | Nodes, edges, traversal | Neo4j, Memgraph, ArangoDB, Postgres + recursive CTE | Unbounded traversal → the whole graph in context |
| Community detector | Cluster into hierarchical groups | Leiden / Louvain | Re-run cost on every update |
| Community summariser | One summary per community per level | LLM | Not refreshed after graph updates |
| Query router | local vs global vs hybrid | Classifier | Sending everything to the global path (expensive) |
| Subgraph serialiser | Graph → text the LLM can read | Custom | Dumping raw triples with no structure |

## 4. Data flow

**Index:** chunk → extract entities (from a **closed type list**) and relations, each with the source chunk id → resolve entities across the corpus → build the graph → detect communities hierarchically → summarise each community at each level → embed node/edge descriptions for seed lookup.

**Local query:** identify seed entities in the question (NER or vector match on node text) → traverse 1–2 hops with a node cap → collect the subgraph plus the source chunks backing each edge → serialise → answer.

**Global query:** map — ask each relevant community summary to answer partially with a relevance score → filter → reduce — synthesise partial answers into one.

**Hybrid:** run normal vector retrieval and graph neighbourhood expansion, fuse with [RRF](hybrid-search-rrf.md). This is the pragmatic production choice.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

# A CLOSED type list is the single most important design decision here.
EntityType = Literal["person", "organization", "product", "technology",
                     "location", "event", "concept"]

class Entity(BaseModel):
    id: str = Field(description="Normalised: lowercase, deduped. 'acme-corp'")
    name: str
    type: EntityType
    description: str = Field(max_length=500, description="Merged across all mentions")
    source_chunk_ids: list[str]
    mention_count: int

class Relation(BaseModel):
    source_id: str
    target_id: str
    type: str = Field(description="Short verb phrase: 'acquired', 'depends_on', 'authored'")
    description: str
    weight: float = Field(ge=0, description="Mention count or extraction confidence")
    source_chunk_ids: list[str] = Field(min_length=1, description="Every edge MUST be traceable")

class Community(BaseModel):
    id: str
    level: int = Field(description="0 = broadest")
    entity_ids: list[str]
    summary: str
    rank: float = Field(description="Importance; drives which communities to consult")

class GraphQueryConfig(BaseModel):
    mode: Literal["local", "global", "hybrid"] = "hybrid"
    max_hops: int = 2
    max_nodes: int = 50
    max_communities: int = 10
    community_level: int = 1
```

## 6. Reference implementation

```python
EXTRACTION_PROMPT = """Extract entities and relationships from the text.

Entity types (use ONLY these): person, organization, product, technology, location, event, concept

For each entity: name (as written), type, one-sentence description.
For each relationship: source name, target name, a SHORT verb phrase type
  ('acquired', 'depends_on', 'authored'), one-sentence description, strength 1-10.

Rules:
- Only what the text states. Never infer from world knowledge.
- Both endpoints of a relationship must be in your entity list.
- Prefer fewer, well-supported extractions over many speculative ones.
Return JSON: {"entities": [...], "relationships": [...]}"""

async def extract(chunk: Chunk) -> tuple[list[Entity], list[Relation]]:
    r = await client.messages.create(model="<FAST_MODEL>", max_tokens=3000, temperature=0,
                                     system=EXTRACTION_PROMPT,
                                     messages=[{"role": "user", "content": chunk.text}])
    data = json.loads(r.content[0].text)
    ents = [Entity(id=normalise(e["name"]), name=e["name"], type=e["type"],
                   description=e["description"], source_chunk_ids=[chunk.id], mention_count=1)
            for e in data["entities"]]
    names = {e.name for e in ents}
    rels = [Relation(source_id=normalise(r_["source"]), target_id=normalise(r_["target"]),
                     type=r_["type"], description=r_["description"],
                     weight=float(r_["strength"]), source_chunk_ids=[chunk.id])
            for r_ in data["relationships"]
            if r_["source"] in names and r_["target"] in names]   # drop dangling edges
    return ents, rels

def local_search(question: str, graph, cfg: GraphQueryConfig) -> str:
    seeds = graph.find_entities_by_embedding(embed(question), top_k=5)
    visited, frontier = set(), [(s, 0) for s in seeds]
    nodes, edges = [], []
    while frontier and len(nodes) < cfg.max_nodes:
        node, depth = frontier.pop(0)
        if node.id in visited or depth > cfg.max_hops:
            continue
        visited.add(node.id)
        nodes.append(node)
        # Expand along the strongest edges first — unbounded expansion floods context.
        for edge in sorted(graph.edges_of(node.id), key=lambda e: -e.weight)[:10]:
            edges.append(edge)
            frontier.append((graph.node(edge.target_id), depth + 1))

    chunk_ids = {cid for e in edges for cid in e.source_chunk_ids}
    return serialise(nodes, edges, graph.chunks(list(chunk_ids)[:20]))

async def global_search(question: str, graph, cfg: GraphQueryConfig) -> str:
    comms = graph.communities(level=cfg.community_level)[:cfg.max_communities]
    # MAP: each community answers independently.
    partials = await asyncio.gather(*[client.messages.create(
        model="<FAST_MODEL>", max_tokens=800, temperature=0,
        system="Answer using ONLY this community summary. Rate its relevance 0-10. "
               "If irrelevant, say so and rate 0. Return JSON {answer, relevance}.",
        messages=[{"role": "user", "content": f"Summary:\n{c.summary}\n\nQuestion: {question}"}])
        for c in comms])
    useful = [json.loads(p.content[0].text) for p in partials]
    useful = [u for u in useful if u["relevance"] >= 3]
    # REDUCE: synthesise.
    r = await client.messages.create(
        model="<STRONG_MODEL>", max_tokens=2000, temperature=0,
        system="Synthesise these partial answers into one. Weight by relevance. "
               "Note disagreements explicitly. Do not add facts.",
        messages=[{"role": "user", "content": json.dumps(useful)}])
    return r.content[0].text
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Entity type list | 7 closed types | Graph coherence | Add domain types deliberately; never leave it open-ended |
| `max_hops` | 2 | Subgraph size | 1 for dense graphs; 3 only for sparse ones |
| `max_nodes` | 50 | Context size | Lower if serialised subgraphs exceed ~4 000 tokens |
| Edge expansion cap | 10 strongest per node | Hub blowup | Lower for graphs with celebrity nodes |
| Community level | 1 | Global answer granularity | 0 for broad themes, 2 for specific ones |
| Extraction model | fast tier | Index cost | Extraction is the dominant index cost |
| Resolution threshold | 0.9 similarity | Merge aggressiveness | Too low merges distinct entities — much worse than duplicates |
| Query mode | hybrid | Coverage | Pure graph loses passages vector search would find |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Graph has 3 nodes for one company | Entity resolution missing or weak | Count entities with high name similarity | Embedding + string resolution with an LLM tiebreak |
| Traversal returns half the graph | Hub node with 10 000 edges | Node-degree distribution | Cap edges per node; expand strongest-first |
| Extracted relationships are wrong | Model inferred from world knowledge | Sample-audit against source chunks | "Only what the text states"; require `source_chunk_ids` |
| Index cost is prohibitive | LLM extraction per chunk at frontier prices | Cost per 1k chunks | Fast model; extract only from chunks likely to hold entities |
| Global search costs $2 per query | Mapping over every community | Communities consulted per query | Rank communities; consult top-N only |
| Graph stale after document updates | No incremental extraction | Index-freshness metric | Content-hash gating; re-extract changed chunks; re-run communities on a schedule |
| Answers cite nothing | Serialised triples without source chunks | Read outputs | Always include the backing chunks alongside the subgraph |
| Worse than plain RAG | Applied to lookup questions | A/B against vector RAG per category | Route: graph for relationship/global questions only |

## 9. Anti-patterns

- **Open-ended entity types.** The model invents hundreds of near-synonymous types and the graph becomes unqueryable. Fix the list.
- **Building GraphRAG before trying agentic RAG.** Two searches solve many multi-hop questions at a fraction of the cost.
- **Edges with no source chunks.** Unverifiable and uncitable. Every edge carries its evidence.
- **Unbounded traversal.** One hub node and the entire graph is in context.
- **Skipping entity resolution.** The graph fragments and traversal finds nothing.
- **Pure-graph retrieval.** You lose everything vector search is good at. Hybrid is the production answer.
- **Never refreshing community summaries.** They silently describe last quarter's corpus.
- **Merging entities too aggressively.** Two distinct people merged into one node produces confidently wrong answers — worse than duplicates.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Multi-hop accuracy | vs vector-RAG baseline on a multi-hop slice | ≥ +15 pts | ≤ +5 pts (not worth it) |
| Entity resolution precision | Merges that were correct | ≥ 0.95 | < 0.90 |
| Entity duplication rate | Entities with a near-duplicate | < 5% | > 15% |
| Extraction precision | Sampled relations supported by the source chunk | ≥ 0.90 | < 0.80 |
| Subgraph size | Tokens serialised, p95 | < 4 000 | > 8 000 |
| Index cost per 1k chunks | USD | < $5 | > $20 |
| Global query cost | USD per query | < $0.10 | > $0.50 |
| Graph freshness | Source change → graph updated | < 24 h | > 1 week |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Vector RAG. Most systems stop here correctly. |
| v1 | Multi-hop questions fail | [Agentic RAG](agentic-rag.md) — much cheaper, solves many of them |
| v2 | Structured relationships exist in the data | Metadata filters + joins, no LLM extraction |
| v3 | Free-text relationships still unretrievable | LLM extraction → graph, local search only |
| v4 | Global/aggregate questions asked | Community detection + hierarchical summaries |
| v5 | Production scale | Hybrid retrieval, incremental extraction, scheduled community refresh |

## 12. Build checklist

- [ ] Agentic RAG and metadata filtering were tried and measurably fell short.
- [ ] The entity type list is closed and documented.
- [ ] Every relation carries at least one `source_chunk_id`.
- [ ] Entity resolution runs corpus-wide, with precision measured.
- [ ] Traversal caps hops, total nodes, and edges expanded per node.
- [ ] Expansion is strongest-edge-first.
- [ ] Retrieval is hybrid: graph neighbourhood fused with vector results.
- [ ] Subgraphs are serialised with their backing source chunks for citation.
- [ ] Global search ranks communities and consults only the top-N.
- [ ] Extraction is gated on content hashes; communities refresh on a schedule.
- [ ] A multi-hop eval slice measures lift over vector RAG.

## 13. Related

- [agentic-rag.md](agentic-rag.md) — the cheaper way to handle multi-hop; try it first
- [hybrid-search-rrf.md](hybrid-search-rrf.md) — the fusion used in hybrid mode
- [rag-evaluation.md](rag-evaluation.md) — proving the lift on a multi-hop slice
- [ingestion-pipeline.md](ingestion-pipeline.md) — running extraction at scale
