+++
id = "llm-as-judge"
title = "LLM as judge"
use_when = "Quality is genuinely subjective and no deterministic check exists, so a model scores the output; or the judge's scores disagree with human raters"
pack = "evaluation"
verified_at = 2026-08-12
stale_after = "90d"
+++

# LLM as Judge

> Using a model to score outputs that code cannot check — with the calibration, rubric design, and bias controls that make the scores mean something.

**Tier:** intermediate
**Use when:** quality is genuinely subjective (helpfulness, tone, faithfulness, reasoning quality) and no deterministic check exists.
**Avoid when:** code can decide. A schema validator, a test suite, or a string comparison is free, exact, and reproducible — an LLM judge is none of those.
**Cost profile:** one call per case per criterion. Judging 200 cases on 4 criteria costs real money and 2–10 minutes; budget for it.

---

## 1. Problem it solves

Some qualities have no programmatic test. "Is this answer faithful to the retrieved context?" "Does this summary preserve the key caveats?" "Is this tone appropriate for a customer?" Human labelling answers these but does not scale to every commit.

An LLM judge scales — **if it agrees with humans.** An uncalibrated judge is a random number generator that produces a confident rationale, and it is worse than no metric because it creates false confidence.

So the work is not "add a judge". It is: write a rubric precise enough that two humans agree, verify the judge agrees with those humans, and control the biases that make judges systematically wrong.

## 2. Shape

```
   output to score
        │
        ▼
  ┌────────────────────────────────────────────────────────┐
  │  JUDGE                                                  │
  │   rubric: explicit criteria with decidable thresholds   │
  │   temperature 0                                         │
  │   → per-criterion score + EVIDENCE (a quote)            │
  └────────────────────────┬───────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
  ┌──────────────────┐          ┌──────────────────────────┐
  │ CALIBRATION      │          │ BIAS CONTROLS            │
  │ 50 human labels  │          │ · position randomisation │
  │ Spearman ≥ 0.7   │          │ · length normalisation   │
  │ else: fix rubric │          │ · no self-preference     │
  └──────────────────┘          │ · rubric before output   │
                                └──────────────────────────┘
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Rubric | The criteria, with thresholds | Decidable by an independent reader | "Rate helpfulness 1–10" — meaningless |
| Judge model | Apply the rubric | Strongest available, temperature 0 | Weaker than the system it judges |
| Evidence requirement | Force grounding | A quote per score | Absent → scores are vibes with a rationale |
| Calibration set | Human labels to check against | ≥ 50 examples | Never built |
| Position controls | Defeat order bias in pairwise judging | Randomise and swap | A/B order held constant |
| Length controls | Defeat verbosity bias | Normalise or instruct explicitly | Longer output scores higher regardless of quality |
| Reference answer | Anchor for correctness | Gold output | Judge grades style instead of content |
| Score aggregation | Combine criteria | Weighted, documented | Unweighted mean hides a failing criterion |

## 4. Data flow

1. Define criteria. Each must be decidable: a reader with the rubric and the output should reach the same verdict as another reader.
2. Human-label ≥ 50 outputs against the rubric — ideally two labellers, to measure inter-human agreement first. **If humans do not agree with each other, the rubric is broken and no judge can fix it.**
3. Run the judge on the same 50. Compute Spearman correlation.
4. Below 0.7: sharpen the rubric (not the model) and repeat.
5. In production: judge at temperature 0, require evidence quotes, apply bias controls.
6. Re-calibrate whenever the rubric, the judge model, or the task changes.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class Criterion(BaseModel):
    id: str
    question: str = Field(description="Answerable yes/no or on a defined scale by an "
                                      "independent reader. Not an adjective.")
    scale: Literal["binary", "likert_3", "likert_5"] = "binary"
    anchors: dict[str, str] = Field(description="What each score level MEANS, concretely. "
                                                "Required for anything above binary.")
    weight: float = 1.0

class CriterionScore(BaseModel):
    id: str
    score: float
    evidence: str = Field(description="Verbatim quote from the output supporting this score. "
                                      "Never a paraphrase.")
    reasoning: str = Field(max_length=200)

class JudgeResult(BaseModel):
    scores: list[CriterionScore]
    weighted_total: float
    blocking_failures: list[str]

class Calibration(BaseModel):
    n_examples: int
    spearman: float
    inter_human_agreement: float = Field(description="Ceiling. The judge cannot beat it.")
    date: str
    judge_model: str
    rubric_version: str
```

## 6. Reference implementation

```python
JUDGE_SYSTEM = """You score an output against a rubric. You do not rewrite it.

For each criterion return:
- score, per the anchors given
- `evidence`: a VERBATIM quote from the output. Never paraphrase. If the criterion concerns
  something absent, quote the nearest relevant text and say what is missing.
- `reasoning`: one sentence

Rules:
- Judge ONLY the stated criteria. Ignore length, formatting, and style unless a criterion
  names them.
- A longer answer is not a better answer.
- Do not reward confident phrasing. Judge content.
- If the output is ambiguous, score it as if a careful reader had to act on it.

Return JSON matching the JudgeResult schema."""

RUBRIC = [
    Criterion(id="faithful", scale="binary",
              question="Is every factual claim in the answer supported by the provided context?",
              anchors={"1": "Every claim traceable to the context",
                       "0": "At least one claim is not in the context, including true "
                            "general knowledge — this measures grounding, not truth"},
              weight=2.0),
    Criterion(id="complete", scale="likert_3",
              question="Does the answer address every part of the question?",
              anchors={"2": "All parts addressed",
                       "1": "Main part addressed, a secondary part missed",
                       "0": "The main part is unaddressed"},
              weight=1.5),
    Criterion(id="caveats", scale="binary",
              question="Are limitations stated in the context preserved in the answer?",
              anchors={"1": "Caveats present in the context appear in the answer",
                       "0": "A caveat was dropped, making the answer misleading"},
              weight=1.0),
]

async def judge(output: str, context: str, question: str) -> JudgeResult:
    payload = (f"CRITERIA:\n{json.dumps([c.model_dump() for c in RUBRIC], indent=2)}\n\n"
               f"QUESTION:\n{question}\n\nCONTEXT:\n{context}\n\nOUTPUT TO SCORE:\n{output}")
    r = await client.messages.create(model="<STRONGEST_MODEL>", max_tokens=2000,
                                     temperature=0, system=JUDGE_SYSTEM,
                                     messages=[{"role": "user", "content": payload}])
    return JudgeResult.model_validate_json(r.content[0].text)
```

Calibration — the step that makes the judge meaningful:

```python
from scipy.stats import spearmanr

async def calibrate(examples: list[dict], human_labels: list[float]) -> Calibration:
    """Run BEFORE trusting any judge score. Repeat after any rubric or model change."""
    judged = [await judge(**e) for e in examples]
    rho, _ = spearmanr([j.weighted_total for j in judged], human_labels)
    if rho < 0.7:
        # The fix is the rubric, not the model. Look at the largest disagreements
        # and ask what the rubric failed to specify.
        worst = sorted(zip(examples, judged, human_labels),
                       key=lambda t: -abs(t[1].weighted_total - t[2]))[:5]
        for ex, j, h in worst:
            print(f"human={h:.2f} judge={j.weighted_total:.2f}\n  {j.scores}\n")
        raise ValueError(f"Judge–human correlation {rho:.2f} < 0.70. Sharpen the rubric.")
    return Calibration(n_examples=len(examples), spearman=rho, inter_human_agreement=0.0,
                       date=today(), judge_model="<STRONGEST_MODEL>", rubric_version="1.0")
```

Pairwise comparison with position control:

```python
import random

async def compare(a: str, b: str, question: str, n_trials: int = 2) -> str:
    """Position bias is real and large. Always swap and average."""
    wins = {"a": 0, "b": 0, "tie": 0}
    for _ in range(n_trials):
        swap = random.random() < 0.5
        first, second = (b, a) if swap else (a, b)
        verdict = await ask_which_is_better(question, first, second)   # "first"|"second"|"tie"
        if verdict == "tie":
            wins["tie"] += 1
        else:
            picked_first = verdict == "first"
            wins["b" if (picked_first ^ (not swap)) else "a"] += 1
    return max(wins, key=wins.get)
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Judge model | strongest available | Score ceiling | Never weaker than the system judged |
| Temperature | 0 | Reproducibility | Always 0 |
| Scale | binary where possible | Agreement | Binary criteria correlate with humans far better than 1–10 |
| Anchors | required above binary | Score meaning | Every level needs a concrete definition |
| Evidence quotes | required | Grounding | Always |
| Calibration size | ≥ 50 | Correlation reliability | 100+ for high-stakes |
| Correlation threshold | 0.7 | Trust bar | Raise toward inter-human agreement |
| Pairwise trials | 2 (swapped) | Position bias | Always ≥ 2 |
| Re-calibration | on rubric/model/task change | Validity | Always |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Nearly every output scores 0.9 | Rubric too vague; sycophancy | Score distribution | Binary criteria with concrete anchors; force discrimination |
| Judge disagrees with humans | Rubric underspecified | Calibration correlation | Sharpen the rubric — not the model |
| Longer answers always win | Verbosity bias | Score vs length correlation | Explicit instruction; normalise; or compare at fixed length |
| Order determines the winner | Position bias | Same pair judged both ways | Randomise and swap; average |
| Judge prefers its own model's style | Self-preference bias | Cross-model comparison | Different judge model; or ensemble |
| Scores are irreproducible | Temperature > 0 | Same input judged 3× | Temperature 0 |
| Judge cost dominates the eval | Judging what code could check | Cost by scorer | Deterministic scorers first |
| Correlation was fine, now it is not | Task or data drifted | Periodic re-calibration | Schedule re-calibration |
| Two humans disagree | The rubric itself is broken | Inter-human agreement | Fix the rubric before touching the judge |

## 9. Anti-patterns

- **Shipping a judge with no calibration.** The scores are unfalsifiable.
- **"Rate this 1–10."** Nobody, human or model, applies that consistently. Decompose into binary criteria.
- **A weaker judge than the system judged.** The judge caps measurable quality.
- **Judging without evidence quotes.** You cannot audit a score with no anchor in the text.
- **LLM judging what code can check.** Schema validity, exact match, test pass/fail — all deterministic.
- **Fixed A/B order in pairwise comparisons.** Position bias is large enough to invert results.
- **Blaming the judge model for low correlation.** It is almost always the rubric.
- **One aggregate score.** Hides which dimension failed, which is the only actionable part.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Judge–human Spearman | On the calibration set | ≥ 0.70 | < 0.50 |
| Inter-human agreement | Between two labellers | ≥ 0.75 | < 0.60 (rubric broken) |
| Score reproducibility | Variance across identical runs | 0 | > 0 (temperature ≠ 0) |
| Score distribution spread | Std dev of scores | > 0.15 | < 0.05 (no discrimination) |
| Length–score correlation | Pearson, score vs output length | \|r\| < 0.3 | > 0.5 |
| Position-swap agreement | Same winner when order swapped | ≥ 90% | < 75% |
| Calibration age | Days since last calibration | < 90 | > 180 |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Manual human review |
| v1 | Review does not scale | Single binary criterion, calibrated on 50 examples |
| v2 | Quality is multi-dimensional | Weighted rubric with per-criterion evidence |
| v3 | Comparing two systems | Pairwise with position randomisation |
| v4 | Judge disagreements matter | Ensemble of judges; escalate disagreements to humans |
| v5 | Continuous operation | Scheduled re-calibration; drift alerts on distribution shift |

## 12. Build checklist

- [ ] Every criterion is decidable by an independent reader with the rubric alone.
- [ ] Binary criteria wherever possible; anchors defined for every non-binary level.
- [ ] Inter-human agreement measured **before** building the judge.
- [ ] ≥ 50 human-labelled examples; Spearman ≥ 0.7 recorded in the repo.
- [ ] Judge model is the strongest available; temperature 0.
- [ ] Evidence quotes required and verified to be verbatim.
- [ ] Pairwise comparisons randomise and swap order.
- [ ] Length–score correlation measured and below 0.3.
- [ ] Deterministic scorers handle everything code can decide.
- [ ] Per-criterion scores reported, not only the weighted total.
- [ ] Re-calibration is triggered by rubric, model, or task changes.

## 13. Related

- [eval-harness-design.md](eval-harness-design.md) — where judges plug in
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — judging multi-step behaviour
- [evaluator-optimizer.md](evaluator-optimizer.md) — the same machinery inside a production loop
- [rag-evaluation.md](rag-evaluation.md) — faithfulness judging specifically
