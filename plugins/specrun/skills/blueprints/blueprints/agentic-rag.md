+++
id = "agentic-rag"
title = "Agentic RAG"
use_when = "One retrieval pass is not enough: the agent has to search, judge what came back and search again, across several sources or several steps"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Agentic RAG

> Retrieval as a tool inside an [agent loop](agent-loop.md): the model decides whether to search, what to search for, judges what came back, and searches again until it can answer.

**Tier:** advanced
**Use when:** questions need multiple retrieval hops ("which of our customers on the enterprise plan also filed a support ticket about latency?"), the corpus spans several sources needing different queries, or a single-shot retrieval measurably fails on your eval set.
**Avoid when:** single-shot retrieval already answers ≥ 85% of queries. Agentic RAG multiplies latency by 3–10× and cost by more; it must earn that.
**Cost profile:** 3–10 LLM calls and 2–6 retrievals per question. p95 latency in seconds, not milliseconds.

---

## 1. Problem it solves

Fixed pipelines retrieve once, with one query, and answer. That breaks in three ways:

1. **Multi-hop.** The second query depends on the first result. "What did the engineer who wrote the auth module say about rate limiting?" needs a lookup, then a search.
2. **Unretrievable-as-asked.** The question's vocabulary has no overlap with the corpus and a single [transformation](query-transformation.md) guess is wrong.
3. **Insufficient evidence.** Retrieval returned three weak chunks. A pipeline answers anyway; an agent notices and searches differently.

The cost is predictability. A fixed pipeline has fixed latency and cost; an agent has a distribution. Bound it explicitly.

## 2. Shape

```
   question
      │
      ▼
 ┌────────────────────────────────────────────────┐
 │  AGENT LOOP (budgeted: max 6 steps, 20s)       │
 │                                                │
 │   ┌──────────┐  "do I have enough?"            │
 │   │  model   │──── no ──▶ choose tool + query   │
 │   └────▲─────┘                    │            │
 │        │                          ▼            │
 │        │              ┌──────────────────────┐ │
 │        │              │ search_docs          │ │
 │        │◀─────────────│ search_tickets       │ │
 │        │  chunks +    │ lookup_entity        │ │
 │        │  scores      │ list_sections        │ │
 │        │              └──────────────────────┘ │
 │        │                                       │
 │        └── yes ──▶ answer with citations       │
 │        └── budget spent ──▶ answer with what   │
 │                            it has + say so     │
 └────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Loop | Iterate until sufficient | [Agent loop](agent-loop.md) | No budget → unbounded latency and cost |
| Retrieval tools | One per source, task-shaped | Hybrid retriever per corpus | One generic `search` over everything → the model cannot target |
| Sufficiency judgement | "Can I answer now?" | Prompt instruction + explicit criteria | Vague → answers on one weak chunk or searches forever |
| Result formatter | Chunks the model can judge | Formatter with scores and sources | Raw chunks with no scores → cannot assess quality |
| Query memory | What has already been tried | Set of normalised queries | Absent → the same search repeats |
| Budget governor | Steps, wall clock, retrievals | Counters | Absent → the p99 is a minute |
| Citation enforcer | Every claim maps to a chunk | Post-hoc validation | Fabricated citations pass unchecked |

## 4. Data flow

1. Question enters the loop with a system prompt stating retrieval strategy **and** the sufficiency criteria.
2. Model either answers directly (if it needs no retrieval — allow this) or calls a retrieval tool.
3. Retrieval runs the full pipeline: [transform](query-transformation.md) → [hybrid](hybrid-search-rrf.md) → [rerank](reranking.md).
4. Results return with chunk id, source, rerank score, and text — the scores let the model judge quality.
5. Query is added to the tried-set; a repeat returns "already tried, got X — search differently".
6. Model assesses: enough to answer? gap identified? → search again with a different query or tool.
7. Budget exhausted → forced answer with an explicit statement of what could not be verified.
8. Post-hoc: validate every citation id exists in the retrieved set.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class RetrievalTool(BaseModel):
    name: str                # search_docs, search_tickets, lookup_customer, list_sections
    description: str         # WHICH corpus, WHAT it contains, WHEN to use it, WHEN NOT to
    corpus_id: str

class RetrievalObservation(BaseModel):
    """What the model sees back. Scores are essential — they let it judge quality."""
    query: str
    n_results: int
    chunks: list[dict] = Field(description="id, source, score, text (truncated)")
    max_score: float
    note: str = Field(description="e.g. 'All scores below 0.3 — likely nothing relevant here.'")

class AgenticRAGConfig(BaseModel):
    max_steps: int = 6
    max_retrievals: int = 4
    max_wall_clock_s: float = 20.0
    chunks_per_retrieval: int = 5
    max_chunk_chars: int = 1_200
    min_useful_score: float = 0.3

class AgenticAnswer(BaseModel):
    answer: str
    citations: list[str]
    retrievals_performed: list[str]
    confidence: float
    unverified_claims: list[str] = Field(description="Stated but not supported by any chunk.")
```

## 6. Reference implementation

```python
SYSTEM = """You answer questions using retrieval tools over separate corpora.

STRATEGY
1. Decide whether retrieval is needed at all. Some questions do not need it — answer directly.
2. Start with one specific query. Do not fire three searches before reading any results.
3. Read what came back. Scores below 0.3 mean nothing relevant was found in that corpus.
4. If results are insufficient, identify the SPECIFIC gap and search for that. Do not
   re-run a paraphrase of a query that already failed.
5. Multi-hop: if the answer requires a fact you must look up first, look it up first.

SUFFICIENCY — you may answer when:
- every part of the question is supported by a retrieved chunk, AND
- no retrieved chunk contradicts your answer.
Otherwise search again, or state plainly what you could not find.

BUDGET: at most {max_retrievals} retrievals. You will be told when it is spent.

CITATIONS: cite the chunk id in brackets after each claim, e.g. [docs::42::a1b2].
Never cite an id you were not given. If a claim has no supporting chunk, say so explicitly."""

def format_observation(query: str, chunks, cfg) -> str:
    if not chunks:
        return (f"Query: {query!r}\nNo results. This corpus likely does not contain it — "
                f"try a different tool or different terms.")
    max_score = max(c.rerank_score for c in chunks)
    note = ("All scores are low — probably nothing relevant here."
            if max_score < cfg.min_useful_score else "")
    body = "\n\n".join(
        f"[{c.id}] (score {c.rerank_score:.2f}, {c.source_uri})\n{c.text[:cfg.max_chunk_chars]}"
        for c in chunks[:cfg.chunks_per_retrieval])
    return f"Query: {query!r} — {len(chunks)} results. {note}\n\n{body}"

async def agentic_rag(question: str, retrievers: dict, cfg: AgenticRAGConfig) -> AgenticAnswer:
    messages = [{"role": "user", "content": question}]
    tried: dict[str, str] = {}
    retrieved_ids: set[str] = set()
    n_retrievals, deadline = 0, time.monotonic() + cfg.max_wall_clock_s

    for step in range(cfg.max_steps):
        spent = n_retrievals >= cfg.max_retrievals or time.monotonic() > deadline
        resp = await client.messages.create(
            model="<MODEL_ID>", max_tokens=2000, temperature=0,
            system=SYSTEM.format(max_retrievals=cfg.max_retrievals)
                   + ("\n\nBUDGET SPENT. Answer now with what you have and state "
                      "explicitly what you could not verify." if spent else ""),
            tools=[] if spent else [t.schema for t in retrievers.values()],
            messages=messages)
        messages.append({"role": "assistant", "content": resp.content})

        calls = [b for b in resp.content if b.type == "tool_use"]
        if not calls:
            text = "".join(b.text for b in resp.content if b.type == "text")
            cited = extract_citations(text)
            return AgenticAnswer(
                answer=text,
                citations=[c for c in cited if c in retrieved_ids],
                retrievals_performed=list(tried),
                confidence=0.9 if all(c in retrieved_ids for c in cited) else 0.4,
                # Fabricated citations are the loudest signal of an unsupported answer.
                unverified_claims=[c for c in cited if c not in retrieved_ids])

        results = []
        for call in calls:
            q = call.input["query"].strip().lower()
            if q in tried:
                results.append({"type": "tool_result", "tool_use_id": call.id, "is_error": True,
                                "content": f"You already searched {q!r} and got: {tried[q]}. "
                                           f"That did not work. Use different terms or another tool."})
                continue
            chunks = await retrievers[call.name].search(call.input["query"])
            n_retrievals += 1
            retrieved_ids.update(c.id for c in chunks)
            obs = format_observation(call.input["query"], chunks, cfg)
            tried[q] = f"{len(chunks)} results, max score " \
                       f"{max((c.rerank_score for c in chunks), default=0):.2f}"
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": obs})
        messages.append({"role": "user", "content": results})

    return AgenticAnswer(answer="Could not complete within budget.", citations=[],
                         retrievals_performed=list(tried), confidence=0.0, unverified_claims=[])
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `max_retrievals` | 4 | Cost and latency ceiling | 2 for interactive chat; 8 for background research |
| `max_wall_clock_s` | 20 | Tail latency | Match the product's patience budget |
| `chunks_per_retrieval` | 5 | Context growth per hop | 3 when many hops are expected |
| `max_chunk_chars` | 1 200 | Context per chunk | Lower with more hops |
| `min_useful_score` | 0.3 | The "nothing here" signal | Calibrate to your reranker |
| Tool granularity | one per corpus | Targeting ability | Split further when corpora need different query styles |
| Direct-answer allowed | yes | Latency on trivial questions | Disable only in strict grounding regimes |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Same query, minor rewordings, repeatedly | No query memory | Normalised query repeat rate | Tried-set returning "already tried, got X" |
| Answers on one weak chunk | Sufficiency criteria vague | Answers with max score < 0.3 | Explicit criteria + surface scores in observations |
| Never stops searching | No budget, or unsatisfiable question | Steps p95 at the cap | Hard budgets + a forced-answer path |
| Cited ids that were never retrieved | Fabricated citations | Post-hoc id validation | Validate every citation; report as `unverified_claims` |
| Context overflow at hop 4 | Every hop appends 5 full chunks | Token occupancy per step | Cap chunks and chars; drop superseded observations |
| Latency p95 unacceptable | Serial hops, each a full LLM round trip | Latency breakdown | Cut `max_retrievals`; route simple questions to single-shot |
| Costs 15× single-shot for +3 pts | Pattern applied to all traffic | Cost and quality vs a single-shot baseline | Route: single-shot by default, agentic on classified multi-hop |
| Picks the wrong corpus every time | Tool descriptions overlap | Tool-selection confusion matrix | See [tool-design](tool-design.md) |

## 9. Anti-patterns

- **One generic `search` tool over everything.** The model cannot target a source it cannot name. One tool per corpus, with a description of what is in it.
- **Returning chunks without scores.** The model cannot judge whether retrieval succeeded, so it treats garbage as evidence.
- **No query memory.** The single most common cause of loops in agentic RAG.
- **Applying it to all traffic.** Route: single-shot handles the majority; agentic handles the classified minority.
- **No citation validation.** A fabricated id looks exactly like a real one in the output.
- **Unbounded retrieval budget.** The p99 becomes a minute and the bill becomes a surprise.
- **Shipping without an A/B against single-shot.** If the lift is under ~5 points, the pattern is not worth its cost.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Answer accuracy | Graded on a multi-hop eval set | ≥ 85% | < 75% |
| Lift vs single-shot | Accuracy delta, same set | ≥ +10 pts | ≤ +3 pts (drop the pattern) |
| Retrievals per question | p50 / p95 | p50 ≤ 2, p95 ≤ 4 | p95 at the cap |
| Citation validity | Cited ids that were retrieved | 100% | < 98% |
| Repeat-query rate | Normalised repeats | < 5% | > 15% |
| Latency p95 | End to end | < 15 s | > 25 s |
| Cost multiplier | vs single-shot | ≤ 8× | > 15× |
| Abstain accuracy | Correct "not found" responses | ≥ 0.85 | < 0.70 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Single-shot [RAG baseline](rag-baseline.md) |
| v1 | Query/answer vocabulary mismatch | [Query transformation](query-transformation.md), still single-shot |
| v2 | Multi-hop questions fail | Retrieval as a tool in an agent loop, hard budgets |
| v3 | Multiple corpora | One tool per corpus with distinct descriptions |
| v4 | Cost pressure | Router: classify multi-hop, send only those to the agentic path |
| v5 | Correctness is critical | Separate verification pass checking each claim against its cited chunk |

## 12. Build checklist

- [ ] A single-shot baseline exists and its accuracy is known.
- [ ] One retrieval tool per corpus, each with a distinct "what's in it / when to use it" description.
- [ ] Observations include chunk id, source, and rerank score.
- [ ] A low-max-score note tells the model when a corpus had nothing.
- [ ] Sufficiency criteria are explicit in the system prompt.
- [ ] A normalised tried-set prevents repeat queries and reports what they returned.
- [ ] Step, retrieval, and wall-clock budgets are all enforced.
- [ ] Budget exhaustion forces an answer that states what was not verified.
- [ ] Every citation id is validated against the retrieved set post-hoc.
- [ ] Chunk count and size per hop are capped so context does not overflow.
- [ ] A multi-hop eval set measures lift over single-shot.

## 13. Related

- [agent-loop.md](agent-loop.md) — the loop mechanics
- [tool-design.md](tool-design.md) — designing the retrieval tools
- [rag-baseline.md](rag-baseline.md) — the baseline this must beat
- [query-transformation.md](query-transformation.md) — the cheaper option; try it first
- [rag-evaluation.md](rag-evaluation.md) — building the multi-hop eval set
