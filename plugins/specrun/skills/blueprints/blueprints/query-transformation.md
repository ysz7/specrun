+++
id = "query-transformation"
title = "Query transformation"
use_when = "Questions are conversational, vague or multi-part, or worded nothing like the corpus, so the query has to be rewritten, expanded or decomposed before it reaches the index"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Query Transformation

> Rewriting, expanding, or decomposing the user's question before retrieval, so the text sent to the index looks like the text that would answer it.

**Tier:** intermediate
**Use when:** queries are conversational ("what about the second one?"), vague, multi-part, or use vocabulary different from the corpus; or when recall is poor despite good chunking and hybrid search.
**Avoid when:** queries are already keyword-like and well-formed (internal search over a technical corpus), or latency budget is under ~200 ms.
**Cost profile:** +1 fast LLM call (~100–300 ms) and, for multi-query variants, N× retrieval cost.

---

## 1. Problem it solves

Retrieval compares the query to passages, but questions and answers are written differently. "Why does my app keep dying?" shares no useful terms with "Out-of-memory conditions in containerised workloads". Three distinct sub-problems hide under "bad recall":

| Problem | Example | Technique |
|---|---|---|
| **Context-dependence** | "and the second one?" | Rewrite against conversation history |
| **Vocabulary mismatch** | user words ≠ corpus words | HyDE, multi-query expansion |
| **Compound questions** | "compare X and Y on price and latency" | Decomposition |
| **Over-broad questions** | "tell me about the platform" | Decomposition or step-back |
| **Over-narrow / jargon** | "the 4021 thing" | Expansion with synonyms |

Applying one technique to all of them wastes latency. Classify first, transform second.

## 2. Shape

```
   raw query + history
          │
          ▼
  ┌──────────────────┐
  │ classify / plan  │  fast model: which transformation, if any?
  └───┬────┬────┬────┘
      │    │    │
 rewrite  HyDE  decompose ──────────┐
      │    │         │              │
      ▼    ▼         ▼              ▼
  standalone  hypothetical    sub-q1  sub-q2  sub-q3
   query       answer            │       │       │
      │         │                ▼       ▼       ▼
      └────┬────┘             retrieve retrieve retrieve
           ▼                     └───────┼───────┘
       retrieve                          ▼
           │                     RRF-fuse / dedupe
           └──────────────┬──────────────┘
                          ▼
                     rerank → LLM
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Classifier | Pick the transformation (or none) | Fast model, temperature 0 | Always transforming, including simple queries |
| Rewriter | History-dependent → standalone | Fast model | Drops constraints from earlier turns |
| Expander | Generate query variants | Fast model | Variants are paraphrases, adding nothing |
| HyDE generator | Write a hypothetical answer, embed that | Fast model | Hallucinated specifics that anchor retrieval wrongly |
| Decomposer | Split into answerable sub-questions | Fast model | Over-splits; 6 sub-queries for a 2-part question |
| Fuser | Merge multi-query results | [RRF](hybrid-search-rrf.md) | Naive concatenation → duplicates |
| Passthrough | Skip transformation entirely | Condition check | Missing → latency tax on every query |

## 4. Data flow

1. Classify the query: `simple` | `context_dependent` | `vocabulary_gap` | `compound` | `broad`.
2. `simple` → **skip everything**, retrieve directly. This should be 40–60% of traffic.
3. `context_dependent` → rewrite against history into a standalone query.
4. `vocabulary_gap` → HyDE: generate a hypothetical answer passage; embed **that** for the dense branch while keeping the original query for BM25.
5. `compound` / `broad` → decompose into 2–4 sub-questions, retrieve each in parallel, fuse with RRF.
6. Deduplicate by chunk id, [rerank](reranking.md), take top-k.
7. Log the original query, the transformation applied, and the transformed text — this is the first thing you need when debugging.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

QueryType = Literal["simple", "context_dependent", "vocabulary_gap", "compound", "broad"]

class QueryPlan(BaseModel):
    query_type: QueryType
    standalone_query: str = Field(description="Always set. Equals the original for `simple`.")
    sub_queries: list[str] = Field(default_factory=list, max_length=4)
    hyde_passage: str | None = None
    reasoning: str = Field(max_length=200)

class TransformConfig(BaseModel):
    enable_hyde: bool = True
    enable_decomposition: bool = True
    max_sub_queries: int = 4
    model: str = "<FAST_MODEL_ID>"
    timeout_ms: int = 1_500
    skip_if_tokens_lt: int = Field(4, description="Very short queries are usually keyword lookups")
```

## 6. Reference implementation

```python
PLANNER_SYSTEM = """Decide how to transform a search query. Be conservative: most queries
need no transformation, and transforming them wastes latency.

query_type:
- simple            — self-contained, specific, corpus vocabulary. USE THIS BY DEFAULT.
- context_dependent — refers to earlier turns ("it", "that one", "the second")
- vocabulary_gap    — colloquial phrasing unlikely to appear in formal documentation
- compound          — genuinely asks 2+ separable questions
- broad             — too general to retrieve precisely

Rules:
- standalone_query is ALWAYS set; for `simple` it equals the original.
- sub_queries only for compound/broad. Maximum 4. Each must be independently answerable.
- Never invent constraints the user did not state.
Return JSON matching QueryPlan."""

HYDE_SYSTEM = """Write a short passage (3-5 sentences) that would appear in documentation
answering this question. Match the register of technical documentation.

Write it as fact, not as an answer to a person. Do not hedge. Do not say "the documentation
says". If you do not know specifics, write plausible general content — this passage is used
only as a retrieval probe and is never shown to anyone."""

async def plan_query(query: str, history: list[dict], cfg: TransformConfig) -> QueryPlan:
    if len(query.split()) < cfg.skip_if_tokens_lt:
        return QueryPlan(query_type="simple", standalone_query=query, reasoning="short/keyword")
    try:
        resp = await asyncio.wait_for(client.messages.create(
            model=cfg.model, max_tokens=600, temperature=0, system=PLANNER_SYSTEM,
            messages=[{"role": "user", "content":
                       f"History:\n{render(history[-4:])}\n\nQuery: {query}"}]),
            timeout=cfg.timeout_ms / 1000)
        return QueryPlan.model_validate_json(resp.content[0].text)
    except Exception:
        return QueryPlan(query_type="simple", standalone_query=query, reasoning="planner failed")

async def transformed_retrieve(query: str, history, retriever, cfg) -> list[Chunk]:
    plan = await plan_query(query, history, cfg)

    if plan.query_type == "simple":
        return await retriever.search(plan.standalone_query)

    if plan.query_type == "vocabulary_gap" and cfg.enable_hyde:
        resp = await client.messages.create(
            model=cfg.model, max_tokens=300, temperature=0.3, system=HYDE_SYSTEM,
            messages=[{"role": "user", "content": plan.standalone_query}])
        hyde = resp.content[0].text
        # Dense branch probes with the hypothetical answer; BM25 keeps the real query terms.
        return await retriever.search_hybrid(dense_text=hyde, lexical_text=plan.standalone_query)

    if plan.sub_queries and cfg.enable_decomposition:
        results = await asyncio.gather(*[retriever.search(q)
                                         for q in plan.sub_queries[:cfg.max_sub_queries]])
        return rrf_fuse({f"sub{i}": _ranked(r) for i, r in enumerate(results)}, FusionConfig())

    return await retriever.search(plan.standalone_query)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Planner model | fast tier | Latency | Never the frontier model — this is a classification |
| `max_sub_queries` | 4 | Cost and latency | 2–3 is usually enough; each adds a full retrieval |
| HyDE temperature | 0.3 | Probe diversity | 0 makes the passage generic; > 0.7 makes it hallucinate specifics |
| HyDE length | 3–5 sentences | Probe quality | Longer passages drift off-topic |
| Passthrough rate target | 40–60% | Latency tax | If under 20%, the planner is over-transforming |
| Planner timeout | 1.5 s | Tail latency | Always degrade to passthrough on timeout |
| History window | last 4 turns | Rewrite quality | Longer for deeply threaded conversations |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Latency up, recall flat | Transforming simple queries | Passthrough rate | Bias the planner toward `simple`; enforce a short-query bypass |
| Rewrite loses a constraint | Rewriter paraphrased instead of resolving references | Diff original vs rewritten | "Resolve references only; preserve all constraints verbatim" |
| HyDE retrieves the wrong thing | Hypothetical passage invented specific wrong facts | Compare HyDE vs plain-query recall | Lower temperature; keep BM25 on the original query |
| Sub-queries return the same chunks | Decomposition produced paraphrases | Result overlap between sub-queries | Require sub-questions to be independently answerable and disjoint |
| Answer loses the compound structure | Fused chunks answer only one part | Manual review | Answer each sub-question, then synthesise |
| Planner is the p95 latency | Serial planner + retrieval | Latency breakdown | Speculatively start plain retrieval in parallel; keep whichever plan wins |
| Cannot debug a bad answer | Transformation not logged | Trace review | Log original, type, and transformed text always |

## 9. Anti-patterns

- **Transforming every query.** The tax is paid on 100% of traffic for benefit on maybe 30%. Classify first.
- **Using the frontier model to rewrite a query.** It is a fast classification task.
- **HyDE alone, replacing the original query.** Keep the original for the lexical branch; HyDE probes semantics only.
- **Decomposing into 6+ sub-queries.** Cost multiplies, results overlap, synthesis degrades. Cap at 4.
- **Rewriting without the conversation history.** The whole point of rewriting is resolving references to earlier turns.
- **Concatenating multi-query results.** Duplicates and no principled ordering. Fuse with RRF.
- **No timeout on the planner.** An LLM call in the critical path with no fallback.
- **Not logging transformations.** Every "why did it retrieve that?" becomes unanswerable.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Recall lift | vs untransformed, same corpus | ≥ +8 pts | ≤ +2 pts |
| Passthrough rate | `simple` classifications | 40–60% | < 20% |
| Planner latency p95 | Classification only | < 400 ms | > 1 s |
| Rewrite fidelity | Constraints preserved (sampled) | ≥ 98% | < 90% |
| Sub-query overlap | Shared chunks between sub-queries | < 40% | > 70% |
| Planner timeout rate | Degraded to passthrough | < 1% | > 5% |
| Recall on conversational queries | Multi-turn slice of the eval set | ≥ 0.85 | < 0.70 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Raw query straight to retrieval |
| v1 | Multi-turn queries fail | History-aware rewriting only, applied to follow-ups |
| v2 | Vocabulary mismatch measured | HyDE for the dense branch, gated by the classifier |
| v3 | Compound questions answered partially | Decomposition + RRF fusion, capped at 4 |
| v4 | Latency tax noticed | Full classifier with a passthrough path; speculative parallel retrieval |
| v5 | Query patterns are stable and known | Learned router / cached transformations for frequent query shapes |

## 12. Build checklist

- [ ] A classifier decides whether to transform; `simple` is the default.
- [ ] Passthrough rate is measured and sits in the 40–60% band.
- [ ] Rewriting receives conversation history and preserves constraints verbatim.
- [ ] HyDE feeds the dense branch only; the original query still drives BM25.
- [ ] Sub-queries are capped at 4 and are independently answerable.
- [ ] Multi-query results are fused with RRF and deduplicated.
- [ ] The planner has a timeout and degrades to passthrough.
- [ ] Original query, type, and transformed text are logged on every request.
- [ ] The eval set contains a conversational/multi-turn slice.
- [ ] Recall lift over the untransformed baseline is measured.

## 13. Related

- [rag-baseline.md](rag-baseline.md) — where the transformed query lands
- [hybrid-search-rrf.md](hybrid-search-rrf.md) — the fusion mechanism reused here
- [agentic-rag.md](agentic-rag.md) — letting the model iterate on queries instead of transforming once
- [routing.md](routing.md) — the classifier pattern in general form
