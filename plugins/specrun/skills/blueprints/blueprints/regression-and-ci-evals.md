+++
id = "regression-and-ci-evals"
title = "Regression and CI evals"
use_when = "Wiring evals into the development loop so a quality regression blocks a merge instead of reaching users"
pack = "evaluation"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Regression and CI Evals

> Wiring evaluation into the development loop so a quality regression blocks a merge instead of reaching users.

**Tier:** intermediate
**Use when:** an eval harness exists and changes ship more than weekly.
**Avoid when:** the harness is not yet calibrated — gating on an untrustworthy metric trains everyone to override the gate, which is worse than no gate.
**Cost profile:** deterministic tiers are effectively free. Full LLM evals cost dollars and minutes per run; tier them so the expensive part runs rarely.

---

## 1. Problem it solves

An eval harness that runs when someone remembers finds regressions in batches, weeks after their cause, when the responsible change is buried under twenty others. The value of an eval is proportional to how quickly it runs after the change that broke something.

The tension: LLM evals are slow and expensive, and a five-minute, five-dollar check on every commit is intolerable. The resolution is **tiering** — a fast deterministic tier on every commit, a full tier nightly and before release — plus a baseline discipline that makes "did this get worse?" a mechanical question.

## 2. Shape

```
  commit ──▶ TIER 1  (every push, <60s, $0)
             deterministic only: schema validity, exact matches,
             retrieval recall@k, tool-selection accuracy, unit tests
                    │ pass
                    ▼
  PR ──────▶ TIER 2  (every PR, <5min, <$1)
             30-50 case subset + judge on the highest-signal criteria
                    │ pass
                    ▼
  merge ───▶ TIER 3  (nightly + pre-release, <30min, <$25)
             full suite, all categories, all judges, cost/latency profile
                    │
                    ▼
             baseline.json  ◀── updated by a reviewed commit, never automatically
                    │
                    ▼
  prod ────▶ TIER 4  (continuous)
             sampled production traces judged online; drift alerts
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Tier 1 | Instant, free, deterministic | Runs on every push | Contains an LLM call, so it is neither |
| Tier 2 | Representative subset + key judges | Stratified sample | Random subset that misses a category |
| Tier 3 | The full picture | Nightly and pre-release | The only tier that exists, so feedback is slow |
| Baseline | Reference metrics per config hash | Committed JSON | Auto-updated, absorbing regressions |
| Tolerance | Allowed drop before failing | Per metric, per category | Wider than the noise floor is meaningless |
| Config hash | Comparability guard | Hash of prompts, model, params | Missing → comparing incomparable runs |
| Flake control | Distinguish noise from regression | Repeat runs; variance tracking | Flaky gate → everyone overrides it |
| Override path | Ship despite a regression, deliberately | Labelled, logged, reviewed | Silent bypass |

## 4. Data flow

1. Compute the config hash from everything that changes behaviour: prompt text, model id, temperature, retrieval parameters, chunking.
2. Run the appropriate tier for the trigger.
3. Compare against `baseline.json` **for the same config hash**. A different hash means the comparison is informational, not a gate.
4. Fail if any overall metric drops beyond tolerance, or any category drops beyond its (wider) tolerance.
5. On failure, publish the failing cases with their outputs as CI artifacts — a red gate with no artifacts is a dead end.
6. Baseline updates are a separate, reviewed commit that states what improved and why.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class Tier(BaseModel):
    name: str
    trigger: str                     # "push" | "pull_request" | "schedule" | "release"
    case_filter: dict                # e.g. {"deterministic_only": True} or {"sample": 40}
    max_duration_s: int
    max_cost_usd: float
    blocking: bool

class Tolerance(BaseModel):
    overall: float = 0.02            # 2 points
    per_category: float = 0.04       # categories are noisier — wider band
    hard_floors: dict[str, float] = Field(
        default_factory=dict,
        description="Absolute minimums regardless of baseline, e.g. {'citation_validity': 0.98}")

class GateResult(BaseModel):
    passed: bool
    config_hash: str
    baseline_hash: str
    comparable: bool                 # False when hashes differ
    regressions: list[str]
    improvements: list[str]
    artifacts: list[str]
```

## 6. Reference implementation

```yaml
# .github/workflows/evals.yml
on:
  push:            { branches: ['**'] }
  pull_request:    {}
  schedule:        [{ cron: '0 3 * * *' }]
  workflow_dispatch: {}

jobs:
  tier1:
    name: evals/deterministic
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
      - run: pip install -e '.[dev]'
      - run: python -m evals.run --tier 1 --gate     # no LLM calls, no API key needed

  tier2:
    name: evals/subset
    if: github.event_name == 'pull_request'
    needs: tier1
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - run: pip install -e '.[dev]'
      - run: python -m evals.run --tier 2 --gate --max-cost 1.00
        env: { ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}' }
      - uses: actions/upload-artifact@v4
        if: always()                                  # failures are the point
        with: { name: eval-failures, path: evals/out/failures/ }

  tier3:
    name: evals/full
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - run: python -m evals.run --tier 3 --report evals/out/report.json
      - uses: actions/upload-artifact@v4
        with: { name: nightly-report, path: evals/out/ }
```

```python
# evals/gate.py
def gate(report: EvalReport, baseline: EvalReport, tol: Tolerance) -> GateResult:
    comparable = report.config_hash == baseline.config_hash
    regressions, improvements = [], []

    # Hard floors apply regardless of baseline or comparability.
    for metric, floor in tol.hard_floors.items():
        value = report.overall.get(metric)
        if value is not None and value < floor:
            regressions.append(f"HARD FLOOR {metric}: {value:.3f} < {floor:.3f}")

    if comparable:
        for metric, value in report.overall.items():
            before = baseline.overall.get(metric)
            if before is None:
                continue
            if value < before - tol.overall:
                regressions.append(f"{metric}: {before:.3f} → {value:.3f}")
            elif value > before + tol.overall:
                improvements.append(f"{metric}: {before:.3f} → {value:.3f}")

        for cat, metrics in report.by_category.items():
            for metric, value in metrics.items():
                before = baseline.by_category.get(cat, {}).get(metric)
                if before is not None and value < before - tol.per_category:
                    regressions.append(f"[{cat}] {metric}: {before:.3f} → {value:.3f}")
    else:
        print(f"Config changed ({baseline.config_hash} → {report.config_hash}). "
              f"Baseline comparison is informational; hard floors still apply. "
              f"Re-baseline in a separate reviewed commit.")

    return GateResult(passed=not regressions, config_hash=report.config_hash,
                      baseline_hash=baseline.config_hash, comparable=comparable,
                      regressions=regressions, improvements=improvements,
                      artifacts=["evals/out/failures/"])
```

Distinguishing a regression from noise:

```python
def is_real_regression(metric: str, delta: float, n_cases: int,
                       historical_std: float) -> bool:
    """Before failing a build, check the drop exceeds the metric's own noise floor."""
    noise = max(historical_std, (0.25 / n_cases) ** 0.5)     # crude binomial floor
    return abs(delta) > 2 * noise
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Tier 1 budget | 60 s, $0 | Per-commit feedback | Must contain zero LLM calls |
| Tier 2 case count | 30–50, stratified | PR signal vs cost | Stratify by category, never random |
| Tier 3 frequency | nightly + pre-release | Full coverage | Daily is enough for most teams |
| Overall tolerance | 2 pts | Gate sensitivity | Must exceed the measured noise floor |
| Per-category tolerance | 4 pts | Slice sensitivity | Wider because slices are smaller |
| Hard floors | on safety-critical metrics | Absolute guarantees | Citation validity, isolation, injection resistance |
| Baseline update | reviewed commit | Regression absorption | Never automatic |
| Override | labelled PR + logged reason | Emergency ship | Must be visible and reviewed |
| Rule owners | non-engineers co-author their cases | Compliance and policy coverage | Any rule a lawyer, risk, or clinical owner cares about |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Everyone overrides the gate | Flaky or slow gate | Override rate | Fix flakiness first; a distrusted gate is worse than none |
| Regressions land anyway | Baseline auto-updated | Baseline diff in git log | Baseline updates are reviewed commits |
| Gate fails on every prompt edit | Comparing across config hashes | Hash mismatch in the report | Re-baseline deliberately on config change |
| Gate red, nobody can debug | No artifacts | Try to investigate a failure | Upload failing cases with outputs, always |
| Tier 1 takes 4 minutes | LLM calls crept in | Duration trend | Tier 1 is deterministic by definition |
| PR subset misses a category | Random sampling | Category coverage in tier 2 | Stratified sampling |
| Noise fails builds | Tolerance below the noise floor | Repeat runs on an unchanged commit | Measure variance; set tolerance at 2× |
| Nightly eval nobody reads | No notification, no owner | Time from red nightly to a fix | Route failures to a channel with an owner |

## 9. Anti-patterns

- **Gating on an uncalibrated judge.** You are blocking merges on a number nobody trusts.
- **Auto-updating the baseline.** Every regression becomes the new normal.
- **Random subsets for the PR tier.** Stratify, or you will miss the category that broke.
- **LLM calls in the per-commit tier.** It becomes slow, costly, and flaky — and then gets disabled.
- **A red gate with no artifacts.** Nobody can act on it.
- **Tolerance below the noise floor.** Builds fail randomly, and the gate loses authority.
- **Silent overrides.** If shipping past a regression is possible without a trace, it will happen routinely.
- **Compliance sign-off as a release gate instead of an eval case.** A rule that can be checked belongs in the suite. A review meeting at release time finds the same problems weeks later, and blocks the deploy while it does.
- **Ignoring improvements.** A metric that jumps 15 points usually means the eval broke, not that the system improved.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Tier 1 duration | p95 | < 60 s | > 180 s |
| Tier 2 duration | p95 | < 5 min | > 15 min |
| Gate flake rate | Failures on unchanged code | < 1% | > 5% |
| Override rate | Merges bypassing the gate | < 2% | > 10% |
| Regressions caught pre-merge | Caught / total found | ≥ 90% | < 70% |
| Time to fix a red nightly | Hours | < 24 h | > 72 h |
| Eval cost per week | USD | budgeted | > 2× budget |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Manual eval runs before releases |
| v1 | A regression reaches users | Nightly full eval with a report |
| v2 | Regressions land during the day | PR-tier subset with a gate |
| v3 | Feedback still too slow | Deterministic tier on every push |
| v4 | Gate distrusted | Noise-floor-aware tolerances; flake tracking; artifacts |
| v5 | Rules come from outside engineering | Compliance, risk, or policy owners co-author their own eval cases; sign-off becomes a green suite rather than a release meeting |
| v6 | Offline diverges from online | Production trace sampling, online judging, drift alerts |

## 12. Build checklist

- [ ] Tier 1 contains zero LLM calls and finishes in under a minute.
- [ ] Tier 2 uses a stratified subset covering every category.
- [ ] Tier 3 runs nightly with an owner who is notified on failure.
- [ ] Every report carries a config hash; gates only compare within a hash.
- [ ] Hard floors exist for safety-critical metrics and apply regardless of baseline.
- [ ] Tolerances exceed the measured noise floor for each metric.
- [ ] Failing cases with full outputs are uploaded as artifacts on every failure.
- [ ] Baseline updates are separate, reviewed commits with a stated reason.
- [ ] Overrides are labelled, logged, and reviewed.
- [ ] Large unexpected improvements are investigated, not celebrated.
- [ ] Rules owned outside engineering (compliance, risk, policy) exist as eval cases authored by their owners, and their sign-off is the suite passing — not a release-day approval.

## 13. Related

- [eval-harness-design.md](eval-harness-design.md) — the harness being gated
- [llm-as-judge.md](llm-as-judge.md) — calibrate before gating on it
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — cost and efficiency gates for agents
