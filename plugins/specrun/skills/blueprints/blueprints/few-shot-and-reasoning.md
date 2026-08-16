+++
id = "few-shot-and-reasoning"
title = "Few-shot examples and reasoning"
use_when = "Output format is inconsistent, or the task needs multi-step derivation, and it is unclear whether to add examples or a reasoning scaffold"
pack = "prompting"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Few-Shot Examples and Reasoning

> Two levers that look similar and are not: examples teach *format and boundaries*; reasoning scaffolds buy *accuracy on multi-step problems*. Using one for the other's job wastes tokens and degrades output.

**Tier:** foundational
**Use when:** output format is inconsistent (→ examples), or the task requires multi-step derivation (→ reasoning).
**Avoid when:** the task is simple retrieval or classification with an obvious format. Both levers cost tokens; neither is free.
**Cost profile:** examples add fixed input tokens (cacheable). Reasoning adds variable output tokens — often 2–10× the final answer's length.

---

## 1. Problem it solves

Two distinct failures get conflated:

| Failure | Lever | Why the other one does not help |
|---|---|---|
| Output shape is inconsistent | **Few-shot examples** | Reasoning does not teach format |
| Model states a plausible but wrong conclusion | **Reasoning scaffold** | More examples do not teach derivation |
| Model handles easy cases, fails at the boundary | **Boundary examples** | Generic examples reinforce the easy path |
| Model is confidently wrong on arithmetic or logic | **Reasoning + verification** | Neither alone is enough |

The most common waste: adding twelve examples to a reasoning problem. The model reproduces the *style* of the examples' answers, including their confidence, without doing the work.

## 2. Shape

```
FEW-SHOT                                  REASONING
                                          
system: task + constraints                system: task + "work through it step by step"
                                          
<example>                                 user: <problem>
  input:  <hard, ambiguous case>          
  output: <exactly the target format>     assistant: <reasoning tokens / scratchpad>
</example>                                           ↓
<example>                                  <derivation, visible or hidden>
  input:  <the other boundary case>                  ↓
  output: <target format>                  <final answer, extracted>
</example>
                                          + verification pass: check the answer
user: <real input>                           against the problem, not the reasoning
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Example set | Teach format + decision boundary | 2–5; more rarely helps | All easy cases |
| Example ordering | Recency effects | Put the most representative last | Random order |
| Negative examples | Show what not to do | Clearly labelled as counter-examples | Model imitates them |
| Reasoning trigger | Elicit derivation before answering | Extended thinking, or "think step by step" | Applied to trivial tasks |
| Scratchpad delimiters | Separate reasoning from the answer | `<thinking>` / `<answer>` | Absent → reasoning leaks into output |
| Answer extractor | Pull the final answer | Parser on the answer block | Parses the reasoning by mistake |
| Verifier | Check the answer independently | Second pass, or code | Verifier re-reads the reasoning and agrees with it |
| Self-consistency | Sample k times, take the majority | k = 3–5 | Applied where a single pass suffices |

## 4. Data flow

**Few-shot:** select examples covering the decision boundary → order with the most representative last → place in the stable (cacheable) prefix → the real input follows.

**Reasoning:** prompt for derivation → model produces reasoning tokens → extract the final answer from a delimited block → optionally verify the answer **against the original problem, not against the reasoning** → optionally sample k times and take the majority.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class Example(BaseModel):
    input: str
    output: str
    covers: str = Field(description="Which boundary or edge case this demonstrates. "
                                    "If you cannot fill this in, the example is redundant.")
    is_counter_example: bool = False

class ReasoningConfig(BaseModel):
    mode: Literal["none", "scratchpad", "extended_thinking"] = "none"
    verify: bool = False
    self_consistency_k: int = Field(1, ge=1, le=5)
    answer_tag: str = "answer"
```

## 6. Reference implementation

Few-shot chosen for boundary coverage, not variety:

```python
# ✗ Three examples of the same easy case — teaches nothing about the boundary
EXAMPLES_BAD = [
    Example(input="The app crashes on startup", output='{"severity": "high"}', covers="?"),
    Example(input="Login is broken",            output='{"severity": "high"}', covers="?"),
    Example(input="Cannot access dashboard",    output='{"severity": "high"}', covers="?"),
]

# ✓ Each example pins one boundary
EXAMPLES_GOOD = [
    Example(input="Users report the export button is greyed out. They can still export "
                  "from the API.",
            output='{"severity": "medium", "severity_quote": "can still export from the API"}',
            covers="workaround exists → medium, not high"),
    Example(input="Export fails with a 500. No other route to the data.",
            output='{"severity": "high", "severity_quote": "No other route to the data"}',
            covers="no workaround → high"),
    Example(input="Export returned another tenant's rows.",
            output='{"severity": "critical", "severity_quote": "another tenant\'s rows"}',
            covers="data exposure → critical regardless of workaround"),
]

def render_examples(examples: list[Example]) -> str:
    # Most representative LAST — recency matters.
    return "\n\n".join(
        f"<example{' type=\"counter\"' if e.is_counter_example else ''}>\n"
        f"<input>{e.input}</input>\n<output>{e.output}</output>\n</example>"
        for e in examples)
```

Reasoning with independent verification:

```python
REASONING_SYSTEM = """Work through the problem before answering.

Put your reasoning inside <thinking> tags. Then give the final answer inside <answer> tags.
The answer block must stand alone — do not refer to your reasoning inside it.

In <thinking>: state what you know, what you need, and each derivation step.
If you notice an error mid-derivation, say so and correct it rather than continuing."""

VERIFY_SYSTEM = """Check whether the answer is correct for the problem.

You are given ONLY the problem and the proposed answer — deliberately not the reasoning,
because reviewing reasoning tends to produce agreement with it.

Verify independently. Return JSON: {"correct": bool, "issue": str|null}"""

async def reason_and_verify(problem: str, cfg: ReasoningConfig) -> str:
    answers = []
    for _ in range(cfg.self_consistency_k):
        r = await client.messages.create(
            model="<MODEL_ID>", max_tokens=4000,
            temperature=0.7 if cfg.self_consistency_k > 1 else 0,
            system=REASONING_SYSTEM,
            messages=[{"role": "user", "content": problem}])
        answers.append(extract_tag(r.content[0].text, cfg.answer_tag))

    answer = max(set(answers), key=answers.count)      # majority vote

    if cfg.verify:
        v = await client.messages.create(
            model="<MODEL_ID>", max_tokens=800, temperature=0, system=VERIFY_SYSTEM,
            messages=[{"role": "user", "content":
                       f"PROBLEM:\n{problem}\n\nPROPOSED ANSWER:\n{answer}"}])
        result = json.loads(v.content[0].text)
        if not result["correct"]:
            return await reason_and_verify(
                f"{problem}\n\nA previous attempt answered {answer!r}, which was rejected: "
                f"{result['issue']}. Solve it correctly.",
                ReasoningConfig(**{**cfg.model_dump(), "verify": False}))   # one retry only
    return answer
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Example count | 2–5 | Format learning | More helps format; almost never helps reasoning |
| Example selection | boundary coverage | Decision quality | Every example must pin a distinct boundary |
| Example ordering | most representative last | Recency bias | Always deliberate |
| Reasoning mode | none | Accuracy on multi-step tasks | On only for genuine derivation |
| `self_consistency_k` | 1 | Variance reduction | 3–5 for high-stakes; costs k× |
| Verification | off | Catches confident errors | On when errors are expensive |
| Temperature (self-consistency) | 0.7 | Sample diversity | 0 makes voting pointless |
| Reasoning visibility | hidden | UX and output cleanliness | Show it when users need to audit the logic |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Model copies an example's *content*, not its pattern | Examples too close to the real input | Outputs echo example values | Vary example surface; use synthetic inputs |
| Reasoning is long and the answer is still wrong | Reasoning is post-hoc rationalisation | Compare reasoning-on vs off accuracy | Add independent verification; decompose the task |
| Verifier always agrees | It read the reasoning | Verifier disagreement rate near 0 | Give the verifier only problem + answer |
| Adding examples made it worse | Examples encode a bias or an inconsistency | Accuracy vs example count | Audit examples for mutual consistency |
| Reasoning leaks into the output | No delimiters | Malformed output | `<thinking>` / `<answer>` tags + extraction |
| Counter-examples imitated | Not clearly marked | Outputs match the anti-pattern | Label explicitly and state why it is wrong |
| Cost tripled, accuracy flat | Reasoning applied to easy tasks | Accuracy delta vs cost | Gate reasoning on task difficulty |
| Self-consistency does not help | Samples are correlated | Agreement ~1.0, accuracy flat | Raise temperature, or vary the framing |

## 9. Anti-patterns

- **Examples for reasoning problems.** The model learns the confident tone of the answers without doing the derivation.
- **Only easy examples.** They teach the model the easy path it already knew.
- **Twenty examples.** Diminishing after ~5; they dilute attention and cost tokens on every call.
- **A verifier that sees the reasoning.** It agrees with it. Verification must be independent.
- **Reasoning on classification tasks.** Cost and latency for no measured gain.
- **Unlabelled counter-examples.** The model imitates them.
- **Examples outside the cached prefix.** They are stable content; put them where they cache.
- **Self-consistency at temperature 0.** Identical samples, k× the cost, no benefit.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Format compliance | Parses on first attempt | ≥ 99% | < 95% |
| Boundary accuracy | Accuracy on ambiguous eval slice | ≥ 85% | < 70% |
| Reasoning lift | Accuracy with vs without | ≥ +10 pts | ≤ +3 pts (remove it) |
| Verification catch rate | Wrong answers caught | ≥ 60% | < 30% |
| Verifier false-positive rate | Correct answers rejected | < 5% | > 15% |
| Self-consistency lift | Accuracy at k vs k=1 | ≥ +5 pts | ≤ +1 pt (set k=1) |
| Output tokens per answer | Reasoning overhead | < 5× the answer | > 10× |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Zero-shot with a clear output contract |
| v1 | Format inconsistent | 2–3 boundary examples in the cached prefix |
| v2 | Errors cluster at the boundary | Add examples pinning exactly that boundary |
| v3 | Multi-step errors | Reasoning scaffold with delimited answer extraction |
| v4 | Confident wrong answers persist | Independent verification pass |
| v5 | Errors are expensive | Self-consistency k=3–5 with diverse framings |

## 12. Build checklist

- [ ] Every example's `covers` field names a distinct boundary it pins.
- [ ] At least one example is the hardest ambiguous case.
- [ ] Examples are mutually consistent (no two imply different rules).
- [ ] Counter-examples are explicitly labelled with why they are wrong.
- [ ] Examples live in the cacheable prefix.
- [ ] Reasoning is enabled only where it shows a measured lift.
- [ ] Reasoning and answer are separately delimited; extraction targets the answer block.
- [ ] The verifier receives problem + answer only, never the reasoning.
- [ ] Self-consistency uses temperature > 0 and diverse framings.
- [ ] Reasoning-on vs reasoning-off accuracy is measured on the same eval set.

## 13. Related

- [prompt-structure.md](prompt-structure.md) — where examples sit in the prompt
- [prompt-caching.md](prompt-caching.md) — why examples belong in the stable prefix
- [structured-output.md](structured-output.md) — extracting the answer reliably
- [evaluator-optimizer.md](evaluator-optimizer.md) — verification as a loop
- [parallelization.md](parallelization.md) — self-consistency as voting
