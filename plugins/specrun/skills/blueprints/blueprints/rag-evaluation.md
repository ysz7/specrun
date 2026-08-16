+++
id = "rag-evaluation"
title = "RAG evaluation"
use_when = "Measuring a RAG system so a regression points at retrieval or at generation, instead of tuning chunk size, k and the prompt by feel"
pack = "retrieval"
verified_at = 2026-08-12
stale_after = "90d"
+++

# RAG Evaluation

> Separately measuring the two halves of a RAG system — did retrieval find the right evidence, and did generation use it faithfully — so a quality regression points at a component instead of a vibe.

**Tier:** foundational
**Use when:** before the second change to any RAG system. Without this, every tuning decision is a guess.
**Avoid when:** never. A RAG system without evaluation is not a system, it is a demo.
**Cost profile:** a few hours to build a 50-question set; minutes and cents per CI run.

---

## 1. Problem it solves

"The answer is wrong" has at least four distinct causes with four different fixes:

| Cause | Fix lives in |
|---|---|
| The gold chunk was never retrieved | chunking, embeddings, hybrid search |
| It was retrieved but ranked 40th | reranking |
| It was in the prompt and the model ignored it | prompt, k too high, noise |
| It was in the prompt and the model contradicted it | temperature, model, instructions |

End-to-end accuracy conflates all four. You need **component metrics**: retrieval measured against gold chunks, generation measured against the retrieved context.

The second reason: without a fixed eval set, you cannot tell an improvement from a lucky sample. Every "this feels better" ships a regression eventually.

## 2. Shape

```
   eval set (50-200 items)
   ┌────────────────────────────────────────────────────┐
   │ question │ gold_chunk_ids │ gold_answer │ category │
   └────────────────────────────────────────────────────┘
              │                        │
              ▼                        ▼
    ┌──────────────────┐     ┌──────────────────────┐
    │ RETRIEVAL EVAL   │     │  GENERATION EVAL     │
    │ recall@k         │     │  faithfulness        │  (vs retrieved context)
    │ precision@k      │     │  answer relevance    │  (vs question)
    │ MRR / nDCG       │     │  correctness         │  (vs gold answer)
    │ deterministic ✓  │     │  abstain accuracy    │
    │ free, instant    │     │  LLM judge, $ + slow │
    └──────────────────┘     └──────────────────────┘
              │                        │
              └───────────┬────────────┘
                          ▼
              per-category breakdown + CI gate
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Eval set | Questions + gold chunk ids + gold answers | JSONL in the repo | Written by the same person who wrote the prompts; unrepresentative |
| Retrieval scorer | recall@k, precision@k, MRR, nDCG | ~40 lines of code | Skipped in favour of end-to-end only |
| Judge | Faithfulness, relevance, correctness | Strong LLM, temperature 0, rubric | Uncalibrated against humans |
| Category tagger | Slice results by query type | Metadata on eval items | Absent → aggregate hides a broken slice |
| Runner | Execute, aggregate, compare to baseline | CI job | Non-deterministic → noise reads as change |
| Regression gate | Fail the build on a drop | Threshold check | Threshold set below current performance |

## 4. Data flow

1. **Build the set.** For each item: question, gold chunk ids, gold answer, category. Source questions from real usage where possible; synthesise the rest from documents and then *have a human verify them*.
2. **Retrieval eval.** Run the retriever, compare returned ids to gold ids. Deterministic, free, instant — run it on every commit.
3. **Generation eval.** Run the full pipeline. Judge faithfulness against the *actually retrieved* context (not the gold context — you are measuring the real system), relevance against the question, correctness against the gold answer.
4. **Slice.** Report per category. A 0.85 aggregate hiding 0.45 on identifier queries is a broken system with a good average.
5. **Gate.** Fail CI if any metric drops more than the tolerance vs the stored baseline.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

Category = Literal["factual", "multi_hop", "identifier", "comparison",
                   "temporal", "unanswerable", "conversational"]

class EvalItem(BaseModel):
    id: str
    question: str
    gold_chunk_ids: list[str] = Field(description="Empty for `unanswerable` items.")
    gold_answer: str = Field(description="For `unanswerable`, the expected abstention text.")
    category: Category
    difficulty: Literal["easy", "medium", "hard"] = "medium"

class RetrievalMetrics(BaseModel):
    recall_at_k: dict[int, float]        # {5: .., 10: .., 20: .., 50: ..}
    precision_at_5: float
    mrr: float
    ndcg_at_10: float
    zero_result_rate: float

class GenerationMetrics(BaseModel):
    faithfulness: float = Field(description="Claims supported by the RETRIEVED context")
    answer_relevance: float
    correctness: float = Field(description="vs gold_answer")
    abstain_precision: float = Field(description="Of abstentions, how many should have abstained")
    abstain_recall: float = Field(description="Of should-abstain items, how many did")
    citation_validity: float

class EvalReport(BaseModel):
    retrieval: RetrievalMetrics
    generation: GenerationMetrics
    by_category: dict[str, dict[str, float]]
    n_items: int
    config_hash: str = Field(description="Hash of chunking/embedding/k config — results are only comparable within one hash")
```

## 6. Reference implementation

```python
import math, json, asyncio

# ---------- retrieval: deterministic, free ----------
def recall_at_k(retrieved: list[str], gold: list[str], k: int) -> float:
    if not gold:
        return 1.0                                     # unanswerable items: nothing to recall
    return len(set(retrieved[:k]) & set(gold)) / len(gold)

def mrr(retrieved: list[str], gold: list[str]) -> float:
    for i, cid in enumerate(retrieved, 1):
        if cid in gold:
            return 1.0 / i
    return 0.0

def ndcg_at_k(retrieved: list[str], gold: list[str], k: int) -> float:
    dcg = sum(1 / math.log2(i + 1) for i, c in enumerate(retrieved[:k], 1) if c in gold)
    idcg = sum(1 / math.log2(i + 1) for i in range(1, min(len(gold), k) + 1))
    return dcg / idcg if idcg else 0.0

# ---------- generation: LLM judge ----------
FAITHFULNESS_JUDGE = """Decide whether the answer is fully supported by the context.

Procedure:
1. Split the answer into atomic factual claims.
2. For each claim, find supporting text in the context, or mark it unsupported.
3. Common knowledge that is not in the context still counts as UNSUPPORTED.
   Faithfulness measures grounding, not truth.

Return JSON: {"claims": [{"claim": "...", "supported": true/false, "evidence": "quote"}],
              "score": <supported / total>}"""

CORRECTNESS_JUDGE = """Compare the answer to the reference answer.

score 1.0 — same information, wording may differ
score 0.5 — partially correct, or correct but incomplete
score 0.0 — wrong, or contradicts the reference

Ignore style, length, and formatting. Judge information content only.
Return JSON: {"score": 0.0-1.0, "reasoning": "one sentence"}"""

async def judge(system: str, payload: str) -> dict:
    r = await client.messages.create(model="<STRONG_MODEL>", max_tokens=1500,
                                     temperature=0, system=system,
                                     messages=[{"role": "user", "content": payload}])
    return json.loads(r.content[0].text)

async def evaluate(items: list[EvalItem], pipeline, config_hash: str) -> EvalReport:
    rows = []
    for item in items:
        result = await pipeline.run(item.question)
        rid = [c.id for c in result.retrieved]
        faith = await judge(FAITHFULNESS_JUDGE,
                            f"CONTEXT:\n{render(result.retrieved)}\n\nANSWER:\n{result.answer}")
        corr = await judge(CORRECTNESS_JUDGE,
                           f"REFERENCE:\n{item.gold_answer}\n\nANSWER:\n{result.answer}")
        rows.append({
            "item": item, "retrieved": rid, "abstained": result.abstained,
            "recall@5": recall_at_k(rid, item.gold_chunk_ids, 5),
            "recall@20": recall_at_k(rid, item.gold_chunk_ids, 20),
            "mrr": mrr(rid, item.gold_chunk_ids),
            "ndcg@10": ndcg_at_k(rid, item.gold_chunk_ids, 10),
            "faithfulness": faith["score"], "correctness": corr["score"],
            "citation_validity": len([c for c in result.sources if c in rid])
                                 / max(len(result.sources), 1),
        })
    return aggregate(rows, config_hash)   # overall + per-category slices
```

Building the set from documents, then verifying by hand:

```python
GEN_QUESTIONS = """Write 3 questions answerable ONLY by this passage.

- One factual (a specific value, name, or date stated here)
- One requiring synthesis across two sentences in the passage
- One using words a real user would use, NOT the passage's own vocabulary

Reject any question answerable from general knowledge without this passage.
Return JSON: [{"question": "...", "answer": "...", "category": "..."}]"""
```

**Synthetic questions are a starting point, not an eval set.** A human reads every one and deletes the trivial and the ambiguous. Expect to discard 30–50%.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Set size | 50 minimum, 150–200 good | Statistical power | ±5 pt differences need ~150 items to be meaningful |
| Category balance | ≥ 8 per category | Slice reliability | Weight toward real traffic distribution |
| Unanswerable share | 10–15% | Abstention measurement | Without these you cannot measure hallucination |
| Judge model | strongest available | Judge accuracy | Never weaker than the generator |
| Judge temperature | 0 | Reproducibility | Always 0 |
| Regression tolerance | −2 pts | CI sensitivity | Tighten as variance drops |
| Run frequency | retrieval every commit, generation nightly + pre-release | Cost | Retrieval eval is free; run it constantly |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Eval scores high, users unhappy | Questions unlike real ones | Compare eval and production query distributions | Source questions from real logs |
| Metrics move randomly between runs | Non-deterministic pipeline or judge | Same config run 3× | Temperature 0 everywhere; fixed seeds; average over runs |
| Judge disagrees with humans | Uncalibrated rubric | Label 50 outputs manually, correlate | Iterate the rubric until correlation ≥ 0.7 |
| Improved retrieval, worse answers | Change raised k and added noise | Both halves measured separately | Always measure both; a retrieval win can be a generation loss |
| One slice is broken, aggregate looks fine | No category breakdown | Per-category report | Report and gate per category |
| Results not comparable across weeks | Chunking or embeddings changed | Config hash on every report | Never compare across config hashes; re-baseline |
| Faithfulness 1.0 but answers wrong | Retrieved context was itself wrong or irrelevant | Faithfulness alongside correctness | Both metrics, always; they measure different things |
| Cannot detect hallucination | No unanswerable items | Category counts | 10–15% unanswerable, with abstention scored |

## 9. Anti-patterns

- **End-to-end accuracy only.** It cannot tell you which component to fix.
- **The prompt author writing the eval set.** They will unconsciously write questions their prompt handles.
- **No unanswerable questions.** Then hallucination is unmeasurable, and it is the failure users care about most.
- **Judging faithfulness against the gold context.** Judge against what the system *actually* retrieved; otherwise you are grading a system you did not ship.
- **A weaker model as judge.** The judge caps the measurable quality.
- **Comparing runs across config changes.** Different chunking means different chunk ids means incomparable recall.
- **Synthetic questions used unverified.** Roughly half are trivial or ambiguous. Human review is not optional.
- **Aggregate-only reporting.** One broken category is invisible until users find it.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Recall@20 | Gold chunk in top-20 | ≥ 0.95 | < 0.85 |
| Recall@5 | Gold chunk in top-5 | ≥ 0.85 | < 0.70 |
| Precision@5 | Retrieved chunks relevant | ≥ 0.70 | < 0.50 |
| MRR | Mean reciprocal rank of first gold | ≥ 0.75 | < 0.55 |
| Faithfulness | Claims supported by retrieved context | ≥ 0.95 | < 0.90 |
| Correctness | vs gold answer | ≥ 0.85 | < 0.75 |
| Abstain recall | Should-abstain items that abstained | ≥ 0.90 | < 0.75 |
| Citation validity | Cited ids present in retrieved set | 1.00 | < 0.98 |
| Judge–human correlation | Spearman on a labelled sample | ≥ 0.70 | < 0.50 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | 20 hand-written questions, manual spot-checks |
| v1 | Second change to the system | 50 items with gold chunk ids; automated recall@k |
| v2 | Answers wrong despite good retrieval | LLM judge for faithfulness and correctness |
| v3 | Slices behave differently | Category tagging + per-slice gates |
| v4 | Regressions ship | CI gate with a stored baseline and tolerance |
| v5 | Offline and online diverge | Production sampling, user feedback labels, drift monitoring |

## 12. Build checklist

- [ ] ≥ 50 items (150+ for confident comparisons), stored as JSONL in the repo.
- [ ] Questions sourced from real usage where possible; synthetic ones human-verified.
- [ ] Every answerable item has gold chunk ids, not just a gold answer.
- [ ] 10–15% of items are unanswerable, with expected abstention text.
- [ ] Items are categorised; every category has ≥ 8 items.
- [ ] Retrieval metrics are computed deterministically, with no LLM involved.
- [ ] Faithfulness is judged against the actually-retrieved context.
- [ ] The judge is the strongest available model, at temperature 0.
- [ ] Judge–human correlation measured on ≥ 50 manually labelled outputs.
- [ ] Every report carries a config hash; runs are only compared within a hash.
- [ ] Retrieval eval runs on every commit; the full eval gates releases.
- [ ] Results are reported per category, not only in aggregate.

## 13. Related

- [rag-baseline.md](rag-baseline.md) — the system under test
- [reranking.md](reranking.md) — the change this measures most often
- [llm-as-judge.md](llm-as-judge.md) — calibrating the judge
- [eval-harness-design.md](eval-harness-design.md) — the general harness
