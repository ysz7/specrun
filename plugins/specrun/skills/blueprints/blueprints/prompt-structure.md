+++
id = "prompt-structure"
title = "Prompt structure"
use_when = "Writing or reworking a production prompt: what belongs in the system block, in what order, how the sections are delimited, and which parts have to stay byte-stable"
pack = "prompting"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Prompt Structure

> The layout of a production prompt: what goes in the system block, what order the pieces appear in, how they are delimited, and which parts must stay byte-stable.

**Tier:** foundational
**Use when:** any prompt that will run more than a handful of times.
**Avoid when:** one-off exploratory chat.
**Cost profile:** structure is free. A well-ordered prompt is usually *cheaper* than a badly ordered one, because the stable prefix caches.

---

## 1. Problem it solves

Prompts that grow by accretion — a rule added here, an example bolted on there — degrade in three predictable ways: instructions contradict each other, the model cannot tell instruction from data, and the whole thing re-tokenises on every call because a timestamp sits at the top.

Structure fixes all three mechanically. Order by stability so the cache works; delimit so instruction and data cannot be confused; put the most important constraints where the model reliably attends.

## 2. Shape

```
┌─ SYSTEM ──────────────────────────────── byte-stable, cacheable ────┐
│ 1. Role and objective        who you are, what you produce          │
│ 2. Capabilities/constraints  what you may and may not do            │
│ 3. Procedure                 numbered steps, if the task has them   │
│ 4. Output contract           exact format, schema, or example       │
│ 5. Examples                  2-5, covering the boundary cases       │
│ 6. Stop condition            when the task is complete              │
└─────────────────────────────────────────────────────────────────────┘
┌─ TOOLS ─────────────────────────────────── stable ──────────────────┐
└─────────────────────────────────────────────────────────────────────┘
┌─ RETRIEVED CONTEXT / MEMORY ────────────── semi-stable ─────────────┐
│ <documents> … </documents>   clearly delimited, marked untrusted    │
└─────────────────────────────────────────────────────────────────────┘
┌─ CONVERSATION ──────────────────────────── volatile ────────────────┐
│ turns …                                                             │
│ ┌─ final user turn ───────────────────────────────────────────────┐ │
│ │ the actual request + any per-call volatile facts (time, ids)    │ │
│ │ + a restatement of the 1-2 constraints that matter most         │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Notes | Primary failure mode |
|---|---|---|---|
| Role | Frame the task and the register | One or two sentences | Elaborate persona fiction with no effect on output |
| Constraints | What must and must not happen | Positive form beats negative | "Do not X" without saying what to do instead |
| Procedure | Ordered steps for multi-stage tasks | Numbered | Prose paragraph the model half-follows |
| Output contract | Exact expected format | Schema or literal example | Described in words instead of shown |
| Examples | Demonstrate the boundary | 2–5, including a hard case | Only easy examples, so the boundary is unlearned |
| Stop condition | When to stop | Explicit | Absent → agents loop |
| Delimiters | Separate instruction from data | XML-ish tags | None, so injected text reads as instruction |
| Volatile block | Time, ids, per-call facts | **Last user turn**, never the system prefix | In the system block → 0% cache hits |

## 4. Data flow

1. Assemble the stable prefix (system + tools). Byte-identical across calls in a session.
2. Append semi-stable context (retrieved documents, memory), clearly delimited and marked untrusted.
3. Append conversation history.
4. Append the current request, plus any volatile facts and a restatement of the one or two constraints that matter most.
5. Cache breakpoints go at the end of each stable region — see [prompt-caching.md](prompt-caching.md).

## 5. Contracts

```python
from pydantic import BaseModel, Field

class PromptLayout(BaseModel):
    """Assembly order is not cosmetic — it determines cost and adherence."""
    role: str
    constraints: list[str] = Field(description="Positive form: what TO do.")
    procedure: list[str] = Field(default_factory=list)
    output_contract: str = Field(description="Schema or a literal example. Not prose.")
    examples: list[tuple[str, str]] = Field(max_length=5)
    stop_condition: str
    # Anything below this line must NOT enter the system block:
    volatile: dict = Field(default_factory=dict,
                           description="time, request id, user name — goes in the last user turn")
```

## 6. Reference implementation

```python
SYSTEM = """You extract structured data from support tickets.

CONSTRAINTS
- Use only information stated in the ticket. Never infer a value that is not written.
- If a field is not present, return null. Do not guess.
- Preserve the customer's original wording in `quote` fields; do not paraphrase.

PROCEDURE
1. Read the ticket in full before extracting anything.
2. Identify the primary issue. If there are several, pick the one the customer
   opened with and list the rest in `secondary_issues`.
3. Extract each field. Leave null what is not stated.
4. Assign severity using the rubric below. Cite the phrase that drove your choice.

SEVERITY RUBRIC
- critical: data loss, security exposure, or a full outage is described
- high:     a core workflow is blocked with no workaround given
- medium:   a workflow is degraded or a workaround exists
- low:      cosmetic, or a question with no impact described

OUTPUT
Return JSON matching this shape and nothing else:
{"issue": str, "severity": "critical|high|medium|low", "severity_quote": str,
 "product_area": str|null, "secondary_issues": [str], "customer_sentiment": str|null}

STOP WHEN
You have emitted valid JSON for every field. Do not add commentary before or after."""

def build_messages(ticket: str, now: str, request_id: str) -> list[dict]:
    return [{
        "role": "user",
        "content": (
            f"<ticket>\n{ticket}\n</ticket>\n\n"
            # Volatile facts live HERE, not in the system block.
            f"<context>current_time: {now} · request_id: {request_id}</context>\n\n"
            # Restating the one constraint that matters most measurably improves adherence.
            "Extract the fields. Return null for anything not stated in the ticket."
        )}]
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| System prompt length | as short as works | Adherence, cost | Long prompts dilute; cut before adding |
| Example count | 2–5 | Format and boundary learning | More helps format, rarely helps reasoning |
| Constraint restatement | 1–2 in the final turn | Adherence on long contexts | Always for critical constraints |
| Delimiters | XML-ish tags | Injection resistance, parse reliability | Always for any injected content |
| Volatile placement | last user turn | Cache hit rate | Never in the system block |
| Temperature | 0–0.3 | Determinism | Higher only for genuinely creative output |
| Procedure format | numbered list | Step adherence | Always over prose for multi-step tasks |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Model ignores a rule stated in the system prompt | Buried in a long prompt, or contradicted elsewhere | Rule-adherence eval | Restate it in the final turn; remove the contradiction |
| Cache hit rate ~0 | Volatile content in the stable prefix | Cache metrics | Move time/ids to the last user turn |
| Model follows instructions found inside a document | No delimiters, no untrusted marking | Injection test suite | Tag untrusted content and say it is data, not instruction |
| Output format drifts | Format described in prose | Parse failure rate | Show a literal example or a JSON Schema |
| Model refuses valid requests | Over-broad negative constraints | False-refusal rate | Positive framing; scope the prohibition |
| Adding a rule breaks another behaviour | Contradictory instructions | Regression eval after each edit | Read the whole prompt after every edit; keep it short enough to read |
| Works on short inputs, fails on long ones | Constraint lost to context dilution | Accuracy vs input length | Restate constraints late; shorten context |
| Every example is easy | Boundary never demonstrated | Errors cluster at the boundary | Include the hardest ambiguous case as an example |

## 9. Anti-patterns

- **Growing a prompt by accretion.** Every addition interacts with everything already there. Re-read the whole prompt after each edit; if it is too long to re-read, it is too long.
- **Elaborate persona fiction.** "You are a world-class expert with 20 years of experience" measurably does very little. State the task and the constraints.
- **Volatile data in the system block.** One timestamp destroys caching for the entire session.
- **Negative-only constraints.** "Never mention pricing" leaves the model guessing what to do when asked about pricing. Say what to do instead.
- **Describing the output format in prose.** Show it.
- **Only easy examples.** The examples teach the boundary; easy ones teach nothing about it.
- **No delimiters around injected content.** The model cannot distinguish your instructions from a document's.
- **Editing prompts without an eval set.** Every "improvement" is a coin flip.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Format compliance | Outputs parsing on the first attempt | ≥ 99% | < 95% |
| Constraint adherence | Rules followed, per rule | ≥ 98% | < 90% |
| Cache hit rate | Cached input / total input tokens | > 70% | < 40% |
| System prompt tokens | Length | < 1 500 | > 3 000 |
| False refusal rate | Valid requests declined | < 1% | > 5% |
| Injection resistance | Injected instructions ignored | 100% | < 100% |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | One paragraph of instruction |
| v1 | Output format varies | Explicit output contract with a literal example |
| v2 | Rules ignored | Structured sections; constraints restated in the final turn |
| v3 | Cost matters | Stable prefix + cache breakpoints |
| v4 | Untrusted content enters | Delimiters, untrusted marking, [injection defence](guardrails-and-injection-defense.md) |
| v5 | Multiple prompt variants | Versioned prompt files, per-variant evals, A/B in production |

## 12. Build checklist

- [ ] The system block is byte-stable across a session.
- [ ] No timestamps, ids, or per-call facts appear in the system block.
- [ ] Constraints are written in positive form.
- [ ] Multi-step tasks use a numbered procedure, not prose.
- [ ] The output contract is a schema or a literal example.
- [ ] Examples include the hardest ambiguous case.
- [ ] A stop condition is stated explicitly.
- [ ] All injected content is delimited and marked as untrusted data.
- [ ] The one or two critical constraints are restated in the final user turn.
- [ ] The prompt is short enough to re-read in full after every edit.
- [ ] An eval set exists and runs before any prompt change ships.

## 13. Related

- [structured-output.md](structured-output.md) — making the output contract enforceable
- [prompt-caching.md](prompt-caching.md) — the economics of the stable prefix
- [guardrails-and-injection-defense.md](guardrails-and-injection-defense.md) — the untrusted-content boundary
- [few-shot-and-reasoning.md](few-shot-and-reasoning.md) — choosing examples that teach
- [eval-harness-design.md](eval-harness-design.md) — measuring prompt changes
