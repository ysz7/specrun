+++
id = "small-models-and-distillation"
title = "Small models and distillation"
use_when = "One task type dominates the token bill or the latency budget and should move to a smaller model, a fine-tune or a distilled student"
pack = "LLM infrastructure"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Small Models and Distillation

<!-- verified: 2026-08-12 -->

> Moving work off the frontier model — to a small model, a fine-tune, or a distilled student —
> where quality holds and the cost difference is an order of magnitude.

**Tier:** advanced
**Use when:** one task type dominates your token spend; latency matters more than generality; you
have (or can generate) labelled examples from a stronger model.
**Avoid when:** spend is not yet material, or the task is genuinely open-ended reasoning. Premature
optimisation here costs weeks and buys a rounding error.
**Cost profile:** distillation costs an offline generation run plus a training run. Payback is
typically 10–50× on inference for the migrated slice.

---

## 1. Problem it solves

Most agent systems spend the majority of their tokens on a minority of task types, and those
tasks are usually narrow: classify an intent, extract fields, decide whether to escalate, rewrite
a query, judge a rubric criterion. None of them need frontier reasoning. They need to be right,
cheap, and fast.

Three levers, in ascending order of effort:

1. **Route** to a smaller model for tasks a small model already handles.
2. **Fine-tune** a small model on your own labelled data for one narrow task.
3. **Distil** — use the frontier model to generate training data, then train a student to
   reproduce its behaviour on your distribution.

The 2026 finding that matters: for **agentic** tasks, distillation works better when it targets
the student's own failure modes rather than blanket-imitating a teacher's traces. Generate data
where the small model is *wrong*, not everywhere.

**Prerequisite:** you cannot do any of this without an eval set. Everything below is a swap you
must prove did not degrade quality, and "it seemed fine" is not proof.

## 2. Shape

```
   measure spend by task type          ← start here, always
        │
        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ Which single task type dominates cost?                       │
   │ Is it narrow (classify / extract / rewrite / judge)?          │
   └───────────────┬─────────────────────────────────────────────┘
          NO ──────┤                              YES
                   ▼                               │
        leave it on the frontier model             ▼
        (open reasoning does not distil well)  ┌──────────────────────┐
                                               │ 1. ROUTE             │
                                               │ try a small model    │
                                               │ against the eval set │
                                               └────────┬─────────────┘
                                          passes │      │ fails
                                                 ▼      ▼
                                            ship it  ┌──────────────────────┐
                                                     │ 2. FINE-TUNE          │
                                                     │ 500-5000 labelled     │
                                                     │ examples from prod    │
                                                     └────────┬─────────────┘
                                                              │ not enough data
                                                              ▼
                                                     ┌──────────────────────┐
                                                     │ 3. DISTIL             │
                                                     │ teacher generates     │
                                                     │ data WHERE THE        │
                                                     │ STUDENT FAILS         │
                                                     └────────┬─────────────┘
                                                              ▼
                                          ┌────────────────────────────────────┐
                                          │ SHADOW: run both, compare, then    │
                                          │ shift traffic gradually with a      │
                                          │ fallback to the frontier model      │
                                          └────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Cost attribution by task | Find the slice worth migrating | Traces tagged with task type | Absent → you optimise the wrong thing |
| Eval set for the slice | Prove no regression | Labelled cases for that task only | Reused general eval that does not cover the slice |
| Candidate small model | The cheaper runtime | Open-weight SLM or a small hosted tier | Chosen by benchmark rather than your eval |
| Training data | Labelled examples | Production traces, or teacher-generated | Only easy cases, so the student learns the easy half |
| Failure-targeted generation | Data where the student is wrong | Student run → errors → teacher labels those | Blanket imitation, which wastes most of the budget |
| Training pipeline | Produce the student | LoRA/PEFT or a managed fine-tune | Unversioned, unreproducible |
| Shadow harness | Compare on live traffic | Dual-run, log both, serve the frontier answer | Straight cutover with no comparison |
| Fallback | Escalate hard cases | Confidence or validation trigger | Absent, so the tail degrades silently |
| Drift monitor | Detect distribution change | Input stats + periodic eval | Student quietly rots as inputs shift |

## 4. Data flow

1. **Attribute cost by task type** from traces. Rank the slices.
2. Pick the top slice. Confirm it is narrow and has a stable output shape.
3. Build or extract a **slice-specific eval set** with labels.
4. **Try routing first**: run a small model against that eval. Often it already passes, and you
   are done in an afternoon.
5. If it fails, collect labelled examples from production. A few hundred to a few thousand is the
   usual range for a narrow task.
6. If data is thin, **distil**: run the student, find where it disagrees with the teacher, and
   have the teacher generate labelled examples **concentrated on those failures**.
7. Train. Version the dataset, the base model, the hyperparameters, and the resulting weights
   together.
8. **Shadow** on live traffic: both models run, the frontier answer is served, both are logged.
   Compare on the eval metrics and on real disagreements.
9. Shift traffic gradually, with a confidence-based fallback to the frontier model.
10. Monitor drift; re-evaluate on a schedule.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class TaskSlice(BaseModel):
    """The unit of migration. If you cannot fill this in, do not start."""
    name: str                          # "intent_classification"
    share_of_cost: float = Field(description="Fraction of total spend. Below 0.15, skip it.")
    calls_per_day: int
    output_shape: Literal["label", "structured", "short_text", "open_text"]
    current_model: str
    current_accuracy: float = Field(description="On the slice eval set, with the frontier model.")

class StudentModel(BaseModel):
    base_model: str
    training_data_ref: str = Field(description="Versioned dataset id — reproducibility depends on it.")
    training_config_ref: str
    weights_ref: str
    eval_accuracy: float
    accuracy_delta: float = Field(description="vs the frontier baseline. Negative is a regression.")
    cost_per_1k_calls_usd: float
    p95_latency_ms: int

class RoutingPolicy(BaseModel):
    slice_name: str
    student: str
    fallback: str = Field(description="Frontier model. Always present.")
    traffic_share: float = Field(0.0, ge=0, le=1)
    escalate_below_confidence: float | None = None
    escalate_on_validation_failure: bool = True
```

## 6. Reference implementation

Failure-targeted data generation — the part that separates a distillation that works from one
that burns budget:

```python
async def generate_targeted_training_data(student, teacher, unlabelled, eval_set, n=2000):
    """Blanket imitation spends most of its budget on cases the student already handles.
    Concentrate on disagreement instead."""
    # 1. Where does the student currently fail?
    failures = []
    for case in eval_set:
        pred = await student.run(case.input)
        if not matches(pred, case.expected):
            failures.append(case)

    # 2. Characterise those failures so we can find more like them.
    profile = await teacher.summarise_failure_modes(failures)

    # 3. Mine unlabelled production inputs resembling the failure profile.
    candidates = rank_by_similarity(unlabelled, profile)[: n * 3]

    # 4. Label with the teacher, keeping only cases where the student is actually wrong —
    #    agreement adds nothing to the training signal.
    data = []
    for inp in candidates:
        t = await teacher.run(inp)
        s = await student.run(inp)
        if not matches(s, t):
            data.append({"input": inp, "output": t, "source": "teacher", "targeted": True})
        if len(data) >= n:
            break

    # 5. Mix in some easy cases so the student does not forget what it already knows.
    data += sample_agreements(unlabelled, teacher, student, n=n // 5)
    return data
```

Routing with a fallback, so the tail never degrades silently:

```python
async def run_slice(task_input, policy: RoutingPolicy) -> Result:
    if random() >= policy.traffic_share:
        return await call(policy.fallback, task_input)

    out = await call(policy.student, task_input)

    # Two independent escalation triggers.
    if policy.escalate_on_validation_failure and not validates(out):
        metrics.incr("student.escalated.validation")
        return await call(policy.fallback, task_input)
    if policy.escalate_below_confidence and out.confidence < policy.escalate_below_confidence:
        metrics.incr("student.escalated.confidence")
        return await call(policy.fallback, task_input)
    return out
```

Shadow mode before any traffic shift:

```python
async def shadow(task_input, policy) -> Result:
    """Serve the frontier answer; log both. Disagreements are your real eval set."""
    frontier, student = await asyncio.gather(
        call(policy.fallback, task_input), call(policy.student, task_input))
    if not matches(student, frontier):
        await disagreements.record(task_input, frontier, student)
    return frontier
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Minimum slice share | 15% of spend | Whether it is worth doing | Below it, the payback does not cover the effort |
| Training set size | 500–5 000 | Student quality | Narrow tasks need less than people expect |
| Targeted-data ratio | 80% failure-targeted, 20% agreement | Training efficiency | All-targeted causes forgetting |
| Shadow duration | ≥ 1 week or 10k calls | Confidence before cutover | Longer for seasonal traffic |
| Traffic ramp | 5% → 25% → 50% → 100% | Blast radius | Hold at each step until metrics are stable |
| Escalation triggers | validation + confidence | Tail quality | Always keep at least one |
| Re-eval cadence | monthly | Drift detection | Weekly after a product change |
| Fallback | frontier model, always present | Safety | Never remove it |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Migrated a slice, spend barely moved | Chose a slice that was not the cost driver | Cost by task type | Attribute first; migrate the top slice |
| Student is fine on average, bad on hard cases | Trained only on easy examples | Accuracy by difficulty band | Failure-targeted generation |
| Quality dropped after cutover | No shadow period | Complaints after deploy | Shadow, then ramp |
| Cannot reproduce the student | Dataset and config unversioned | Try to retrain it | Version dataset, config, and weights together |
| Student degrades over months | Input distribution drifted | Scheduled re-eval | Drift monitoring; periodic retraining |
| Tail requests fail silently | No escalation path | Compare tail metrics | Confidence and validation escalation |
| Distillation cost exceeded the saving | Blanket imitation | Generation cost vs projected saving | Target failures; cap generation |
| Student learned the teacher's mistakes | Teacher output taken as ground truth | Sample-audit teacher labels | Human-verify a sample; do not distil an unmeasured teacher |

## 9. Anti-patterns

- **Optimising before attributing cost.** Migrate the slice that dominates spend, not the one that
  is easiest.
- **No slice-specific eval set.** You cannot prove a swap did not regress, so you will not notice
  when it did.
- **Blanket imitation distillation.** Most of the budget goes to cases the student already gets
  right.
- **Straight cutover.** Shadow first; the disagreements are the most valuable data you will get.
- **Removing the frontier fallback.** The tail is where small models fail, and the tail is where
  users notice.
- **Distilling open-ended reasoning.** It transfers poorly. Distil narrow, well-shaped tasks.
- **Choosing a small model by public benchmark.** Benchmarks are not your distribution. Use your
  eval set.
- **Treating teacher output as ground truth.** The teacher is wrong sometimes, and the student
  will faithfully learn that.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Slice cost share | Spend on the migrated slice / total | Tracked before and after | — |
| Cost reduction | On the migrated slice | ≥ 10× | < 3× (reconsider the effort) |
| Accuracy delta | Student vs frontier on the slice eval | ≥ −2 pts | < −5 pts |
| Tail accuracy delta | On the hardest difficulty band | ≥ −5 pts | < −10 pts |
| Escalation rate | Calls falling back to frontier | 5–20% | > 40% (student is not ready) |
| p95 latency | Student vs frontier | ≥ 2× faster | No improvement |
| Shadow disagreement rate | Before cutover | < 10% | > 25% |
| Drift | Accuracy change since deployment | < 3 pts/quarter | > 8 pts |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | Everything on the frontier model |
| v1 | Spend becomes material | Cost attribution by task type in traces |
| v2 | One slice dominates | Route that slice to a small model; measure on its eval set |
| v3 | Small model falls short | Fine-tune on production examples |
| v4 | Not enough labelled data | Failure-targeted distillation from the frontier model |
| v5 | Several slices migrated | Model registry, scheduled re-eval, automated drift alerts |

## 12. Build checklist

- [ ] Cost is attributed by task type; the target slice is ≥ 15% of spend.
- [ ] A slice-specific eval set with labels exists before any change.
- [ ] Plain routing to a small model was tried first and measured.
- [ ] Training data is 80% targeted at the student's actual failures, 20% agreement cases.
- [ ] A sample of teacher labels was human-verified before training on them.
- [ ] Dataset, training config, and weights are versioned together and reproducible.
- [ ] Shadow mode ran for ≥ 1 week or 10 000 calls; disagreements were reviewed.
- [ ] Traffic ramps in stages, holding at each until metrics are stable.
- [ ] A frontier fallback exists with validation-based and confidence-based escalation.
- [ ] Accuracy is tracked by difficulty band, not only in aggregate.
- [ ] A scheduled re-eval detects drift.
- [ ] The realised cost reduction is measured against the projection.

## 13. Related

- [cost-and-rate-limits.md](cost-and-rate-limits.md) — the attribution this depends on
- [gateway-and-routing.md](gateway-and-routing.md) — where model routing is implemented
- [observability-tracing.md](observability-tracing.md) — tagging traces by task type
- [eval-harness-design.md](eval-harness-design.md) — the slice eval set
- [prompt-caching.md](prompt-caching.md) — try this before distilling
