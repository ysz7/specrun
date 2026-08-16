---
name: build-eval-set
description: Creates a labelled evaluation dataset and scoring harness for an LLM system - sourcing cases from real usage, categorising them, adding adversarial and should-fail cases, and wiring deterministic scorers plus a baseline. Use when the user wants to evaluate an LLM system, measure prompt or model quality, build a test set for AI, set up eval CI, or prove that a change actually helped.
metadata:
  version: "1.0"
  source: AI Engineer Assets
---

# Build an Eval Set

The dataset is the product. A perfect harness over an unrepresentative dataset measures nothing.

## When this applies

- An LLM system exists with no measurement
- About to change a prompt, model, or retrieval config
- Setting up CI gates for AI quality

## Do not use for

- Retrieval-specific eval sets → `../../../RAG System/skills/build-rag-evalset`
- Making a judge agree with humans → `calibrate-judge`

## Inputs to collect first

| Input | Why needed | Default if unspecified |
|---|---|---|
| The system and what "correct" means | Defines the scorers | **Blocking** |
| Real usage data (logs, tickets, transcripts) | The only representative source | Synthesise, and flag the limitation loudly |
| Known failure cases | The highest-value cases in the set | Ask — everyone has three |
| Which decisions this eval will gate | Sets the required precision | Ask |

## Procedure

### Step 1 — Start from real failures

Before writing a single synthetic case, collect every known failure: bug reports, complaints, cases someone had to fix by hand. These are the highest-signal cases in the set and they are free.

**Stop condition:** every known failure is a case.

### Step 2 — Sample real inputs

Pull from production logs. Stratify: frequent cases, rare cases, long inputs, short inputs, edge formats. If there is no production yet, use the closest real corpus and say so — do not pretend synthetic data is representative.

**Stop condition:** ≥ 60% of cases derive from real inputs, or the gap is documented.

### Step 3 — Generate the remainder, then cull

Generate candidates from the corpus, then **read every one** and delete: answerable without the system, ambiguous, trivially easy, duplicate. Expect to cut 30–50%.

**Stop condition:** every surviving case was read by a person.

### Step 4 — Add adversarial and should-fail cases

The cases everyone forgets, and the ones that matter most:

- Inputs the system **should refuse or abstain on**
- Inputs containing injected instructions
- Malformed, empty, or truncated inputs
- Inputs in the wrong language or format
- Boundary cases where two categories are equally defensible

Target 15–20% of the set. Without these, hallucination and injection are unmeasurable.

**Stop condition:** 15–20% of cases are adversarial or should-fail.

### Step 5 — Categorise and balance

Tag every case with a category and a difficulty. Every category needs **≥ 8 cases** or its slice metric is noise. Add cases to thin categories rather than reporting an unreliable number.

**Stop condition:** every category has ≥ 8 cases; the report will slice by category.

### Step 6 — Write deterministic scorers first

Everything code can decide, code should decide — free, exact, reproducible:

- Schema and format validity
- Exact or normalised match where there is one right answer
- Required substrings present, forbidden substrings absent
- Numeric tolerance
- Referential checks (does that id exist?)
- Tool selection, step counts, cost budgets for agents

Only what remains goes to a judge.

**Stop condition:** ≥ 60% of scoring involves no LLM.

### Step 7 — Add judges only where necessary

For genuinely subjective criteria, follow `calibrate-judge`. Do not ship a judge you have not calibrated.

**Stop condition:** every judge has a recorded Spearman ≥ 0.7.

### Step 8 — Build the runner

Concurrent execution with bounded parallelism, **raw output stored for every case**, aggregation overall and per category, a config hash on every report, and exceptions recorded as failures rather than crashes.

**Stop condition:** a failing case can be fully debugged from stored artifacts.

### Step 9 — Baseline and gate

Run against current production. Commit the result as `baseline.json`. Add the CI tiers from `../blueprints/blueprints/regression-and-ci-evals.md`. Verify the gate catches a deliberately broken version.

**Stop condition:** CI fails on an intentionally degraded system.

### Step 10 — Make it grow

Add a rule to the team's definition of done: **every production bug becomes a permanent eval case.** An eval set that does not grow decays into irrelevance within months.

**Stop condition:** the rule is written down where the team sees it.

## Output contract

```
evals/
├── dataset.jsonl      # {id, input, expected, category, difficulty, tags}
├── scorers.py         # deterministic first; judges last
├── judges.py          # rubrics, temperature 0
├── run.py             # concurrent, stores outputs, config hash, per-category
├── gate.py            # baseline comparison, tolerances, hard floors
├── baseline.json      # committed, reviewed, never auto-updated
├── calibration.md     # judge-human correlation, date, method
└── out/failures/      # raw outputs for every failing case
```

## Verification

- [ ] ≥ 50 cases (150+ for confident ±5 pt comparisons)
- [ ] ≥ 60% derived from real inputs, or the gap is documented
- [ ] Every case read by a human
- [ ] 15–20% adversarial or should-fail
- [ ] Every category has ≥ 8 cases
- [ ] ≥ 60% of scoring is deterministic
- [ ] Every judge has a recorded calibration ≥ 0.7
- [ ] Raw outputs stored for every case
- [ ] Config hash on every report
- [ ] Running the same commit twice varies by < 1 point
- [ ] CI gate catches a deliberately broken system

## Common mistakes

| Mistake | Why it happens | Correct action |
|---|---|---|
| Cases the system already passes | Feels productive | Measures nothing |
| The prompt author writes the cases | Convenient | They write what their prompt handles |
| No should-fail cases | They feel like trick questions | They are the only hallucination measurement |
| LLM judges for deterministic checks | Habit | Slower, costlier, less reliable |
| Only aggregate metrics | Simpler report | Hides the one broken category |
| Storing scores, not outputs | Smaller artifacts | A score with no artifact is undebuggable |
| Building it once | Feels finished | Every production bug must become a case |
| Gating before calibrating | Eager for the gate | The team learns to override it |

## References

- `../blueprints/blueprints/eval-harness-design.md` — harness structure and contracts
- `../blueprints/blueprints/llm-as-judge.md` — when and how to add a judge
- `../blueprints/blueprints/regression-and-ci-evals.md` — tiering and gating
- `../blueprints/blueprints/agent-trajectory-eval.md` — multi-step systems
