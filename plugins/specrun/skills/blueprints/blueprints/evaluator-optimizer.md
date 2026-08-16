+++
id = "evaluator-optimizer"
title = "Evaluator and optimizer"
use_when = "First drafts are reliably mediocre and the quality criteria can be stated, so a critic scores each attempt and the generator revises until it clears a bar"
pack = "agent workflows"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Evaluator–Optimizer (Generate–Critique–Revise)

> Two roles in a loop: a generator produces a candidate, an evaluator scores it against explicit criteria and returns actionable feedback, the generator revises. Repeat until the score clears a bar or the budget runs out.

**Tier:** intermediate
**Use when:** you can state quality criteria explicitly; a human reviewing the output would give feedback that measurably improves it; the first draft is reliably mediocre.
**Avoid when:** criteria are subjective and unstated ("make it better"); the generator is already at ceiling; a deterministic checker (compiler, test suite, linter) can replace the evaluator — use that instead, it is free and correct.
**Cost profile:** 2N+1 LLM calls for N rounds. Gains concentrate in round 1 and are usually gone by round 3.

---

## 1. Problem it solves

Single-pass generation stops at "acceptable". Some tasks have a large, reachable gap between first draft and good — literary translation, tricky SQL, a security-sensitive patch, a piece of writing with a house style.

The pattern works exactly when the model can *recognise* quality better than it can *produce* it on the first try. That asymmetry is real for well-specified criteria and absent for vague ones — which is why the rubric, not the loop, is the actual engineering work here.

**Always prefer a deterministic evaluator.** If tests, a type checker, or a schema validator can judge the output, use them: zero cost, zero hallucination, perfect consistency. The LLM evaluator is for what code cannot check.

## 2. Shape

```
       task
        │
        ▼
   ┌──────────┐   candidate   ┌───────────────┐
   │GENERATOR │──────────────▶│  EVALUATOR    │
   │          │               │ rubric-scored │
   └────▲─────┘               └───────┬───────┘
        │                             │
        │  feedback: score +          │ score ≥ threshold?
        │  specific, actionable       │
        │  edits + failing criteria   ├── yes ──▶ return candidate
        └─────────────────────────────┤
                                      └── no, rounds < max ──▶ loop
                                          rounds = max ──────▶ return best-so-far
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Generator | Produce and revise the candidate | Strong model, moderate temperature | Rewrites everything each round instead of fixing what was flagged |
| Rubric | The explicit, weighted criteria | Config, versioned | Vague criteria → useless feedback |
| Deterministic checks | Compile, test, lint, validate | Real tooling | Skipped in favour of LLM judgement |
| Evaluator | Score + actionable feedback per criterion | Strong model, temperature 0 | Says "improve clarity" instead of naming the sentence |
| Convergence guard | Stop on plateau or regression | Score history | Absent → burns budget on noise |
| Best-so-far tracker | Keep the highest scorer | Simple max | Absent → returns a worse final round |

## 4. Data flow

1. Generator produces candidate v1.
2. **Deterministic checks first.** Failures go straight back as facts — do not spend an LLM call to discover a syntax error.
3. Evaluator scores v1 against each rubric criterion, returning per-criterion score, verdict, and a concrete edit.
4. If `score ≥ threshold` → return. If `round == max` → return best-so-far.
5. If `score ≤ previous - ε` → regression: return the previous best and stop.
6. If `|score - previous| < ε` → plateau: stop.
7. Otherwise the generator revises, receiving **the candidate and the failing criteria only** — not the whole history.
8. Goto 2.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class Criterion(BaseModel):
    id: str
    description: str = Field(description="Testable. 'No sentence over 30 words', not 'concise'.")
    weight: float = Field(gt=0, le=1)

class CriterionScore(BaseModel):
    id: str
    score: float = Field(ge=0, le=1)
    verdict: Literal["pass", "fail"]
    evidence: str = Field(description="Quote the exact offending text or line number.")
    fix: str = Field(description="The specific edit to make. Imperative. Not 'improve X'.")

class Evaluation(BaseModel):
    scores: list[CriterionScore]
    weighted_total: float = Field(ge=0, le=1)
    blocking: list[str] = Field(description="Criterion ids that must pass before returning.")

class Round(BaseModel):
    n: int
    candidate: str
    evaluation: Evaluation
    tokens: int
```

## 6. Reference implementation

```python
from anthropic import Anthropic
import json

client = Anthropic()

EVALUATOR_SYSTEM = """You score a candidate against a rubric. You do not rewrite it.

For every criterion return:
- score 0.0-1.0 and a pass/fail verdict
- `evidence`: quote the exact offending text (or line number). Never paraphrase.
- `fix`: the specific edit, in the imperative. "Replace 'utilise' with 'use' in line 4",
  not "improve word choice".

Be strict. A 0.9 means you would ship it. If a criterion passes, still quote what
satisfies it. Return JSON matching the Evaluation schema."""

def deterministic_checks(candidate: str) -> list[str]:
    """Run everything code can decide. Free and always right."""
    problems = []
    # e.g. json.loads / ast.parse / subprocess pytest / jsonschema.validate
    return problems

def optimize(task: str, rubric: list[Criterion], *, threshold=0.85,
             max_rounds=3, epsilon=0.02) -> tuple[str, list[Round]]:
    history: list[Round] = []
    candidate = generate(task, feedback=None)

    for n in range(max_rounds):
        hard = deterministic_checks(candidate)
        if hard:
            candidate = generate(task, feedback="Fix these first:\n" + "\n".join(hard),
                                 previous=candidate)
            continue

        resp = client.messages.create(
            model="<FRONTIER_MODEL>", max_tokens=3000, temperature=0,
            system=EVALUATOR_SYSTEM,
            messages=[{"role": "user", "content":
                       f"TASK:\n{task}\n\nRUBRIC:\n"
                       f"{json.dumps([c.model_dump() for c in rubric], indent=2)}\n\n"
                       f"CANDIDATE:\n{candidate}"}])
        ev = Evaluation.model_validate_json(resp.content[0].text)
        history.append(Round(n=n, candidate=candidate, evaluation=ev, tokens=0))

        blocking_ok = all(s.verdict == "pass" for s in ev.scores if s.id in ev.blocking)
        if ev.weighted_total >= threshold and blocking_ok:
            return candidate, history

        if n > 0:
            prev = history[-2].evaluation.weighted_total
            if ev.weighted_total <= prev - epsilon:          # regression
                best = max(history, key=lambda r: r.evaluation.weighted_total)
                return best.candidate, history
            if abs(ev.weighted_total - prev) < epsilon:      # plateau
                break

        failing = [s for s in ev.scores if s.verdict == "fail"]
        feedback = "\n".join(f"[{s.id}] {s.evidence}\n  → {s.fix}" for s in failing)
        candidate = generate(task, feedback=feedback, previous=candidate)

    best = max(history, key=lambda r: r.evaluation.weighted_total)
    return best.candidate, history

def generate(task: str, feedback: str | None, previous: str | None = None) -> str:
    system = ("You produce the artifact. When given feedback, change ONLY what the "
              "feedback identifies. Preserve everything else verbatim — unrequested "
              "rewrites are a failure.")
    user = f"TASK:\n{task}"
    if previous:
        user += f"\n\nYOUR PREVIOUS VERSION:\n{previous}\n\nFEEDBACK TO ADDRESS:\n{feedback}"
    return client.messages.create(model="<FRONTIER_MODEL>", max_tokens=4096,
                                  temperature=0.4, system=system,
                                  messages=[{"role": "user", "content": user}]).content[0].text
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `max_rounds` | 3 | Cost ceiling | 2 is enough for most tasks; > 4 almost never pays |
| `threshold` | 0.85 | Strictness | Raise only if the evaluator is calibrated against human judgement |
| `epsilon` | 0.02 | Plateau sensitivity | Widen if scores are noisy |
| Evaluator temperature | 0 | Score stability | Always 0 |
| Generator temperature | 0.3–0.6 | Revision diversity | Lower if revisions drift off-task |
| Evaluator model | ≥ generator tier | Feedback quality | Never use a weaker model to judge a stronger one's work |
| Blocking criteria | safety/correctness | Non-negotiables | Anything that must never ship broken |
| Feedback scope | failing criteria only | Revision focus | Sending everything causes full rewrites |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Score oscillates round to round | Evaluator not deterministic | Same input scored 3× | Temperature 0; sharpen the rubric wording |
| Round 2 is worse than round 1 | Generator rewrote unflagged parts | Diff size vs feedback size | "Change only what feedback identifies" + return best-so-far |
| Feedback is unusable | Criteria not testable | Read the `fix` fields | Require `evidence` (a quote) and an imperative `fix` |
| Evaluator always ~0.9 | Sycophancy / weak rubric | Score distribution | Force at least one `fail` per round early on; calibrate against human labels |
| Gains vanish after round 1 | Task at ceiling | Score-by-round curve | Set `max_rounds=1`; the loop is not earning its cost |
| Cost 6× for +2 points | Loop applied to an easy task | Quality lift vs round-0 baseline | Gate the loop on a first-pass score below threshold |
| Passes the rubric, still bad | Rubric misses the real quality dimension | Human spot-checks | Add the missing criterion; the rubric is the product |
| LLM evaluator misses a syntax error | Deterministic checks skipped | Downstream breakage | Run compilers/tests/validators before the evaluator, always |

## 9. Anti-patterns

- **"Critique and improve this" with no rubric.** The evaluator invents criteria each round and the loop wanders. The rubric is the pattern.
- **LLM evaluation of what code can check.** Tests, type checkers, linters, and schema validators are free, correct, and consistent. Use them first.
- **Weaker evaluator than generator.** The evaluator sets the ceiling.
- **Unbounded rounds "until it's good".** Cap at 3 and return best-so-far.
- **Sending the whole critique history to the generator.** Context grows, the model re-anchors on old problems, revisions get muddier.
- **No best-so-far tracking.** Returning the last round means shipping a regression whenever round N is worse.
- **Generator and evaluator sharing a system prompt.** They must be genuinely separate roles or the evaluator rubber-stamps.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Round-1 lift | Score after 1 revision − round 0 | ≥ +0.10 | ≤ +0.03 (drop the loop) |
| Marginal lift, round n | Score(n) − Score(n−1) | ≥ +0.03 to continue | < 0.02 → stop |
| Regression rate | Runs where a round scored lower | < 10% | > 25% |
| Evaluator–human agreement | Correlation on a labelled sample | ≥ 0.7 | < 0.5 (rubric is broken) |
| Convergence rate | Runs hitting threshold before `max_rounds` | ≥ 70% | < 40% |
| Cost multiplier | vs single generation | ≤ 4× | > 6× |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Single generation |
| v1 | Deterministic defects ship | Compiler/test/schema checks + auto-repair (no LLM evaluator yet) |
| v2 | Subjective quality gaps persist | Weighted rubric + LLM evaluator, `max_rounds=2` |
| v3 | Evaluator disagrees with humans | Calibrate: label 50 outputs, tune criteria until correlation ≥ 0.7 |
| v4 | Loop is worth its cost | Gate on first-pass score; only run the loop on candidates below threshold |

## 12. Build checklist

- [ ] Every criterion is testable by an independent reader.
- [ ] Deterministic checks run before any LLM evaluation.
- [ ] The evaluator returns quoted evidence and an imperative fix per criterion.
- [ ] The evaluator is at least as strong as the generator; temperature 0.
- [ ] Only failing criteria are sent back to the generator.
- [ ] The generator is instructed to change only what was flagged.
- [ ] Best-so-far is tracked and returned on regression or plateau.
- [ ] Rounds are capped and marginal lift per round is measured.
- [ ] Blocking criteria (safety, correctness) are enumerated and enforced.
- [ ] Evaluator scores are calibrated against ≥ 50 human-labelled outputs.

## 13. Related

- [prompt-chaining.md](prompt-chaining.md) — the acyclic version; the gate is a mini-evaluator
- [agent-loop.md](agent-loop.md) — when revision needs tools, not just text
- [llm-as-judge.md](llm-as-judge.md) — building and calibrating the evaluator
- [structured-output.md](structured-output.md) — making evaluations parseable
