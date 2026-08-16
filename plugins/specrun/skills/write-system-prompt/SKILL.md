---
name: write-system-prompt
description: Writes or restructures a production system prompt with a stable cacheable prefix, positive constraints, a numbered procedure, an explicit output contract, boundary examples, and a stop condition. Use when the user asks to write a prompt, improve a prompt, fix a model that ignores instructions, reduce prompt cost, make outputs more consistent, or turn ad-hoc instructions into something production-grade.
metadata:
  version: "1.0"
  source: AI Engineer Assets
---

# Write a System Prompt

## When this applies

- Writing a prompt that will run more than a handful of times
- A model ignores rules that are clearly stated
- Outputs are inconsistent between calls
- A prompt has grown by accretion and nobody dares edit it

## Do not use for

- Data extraction specifically → `extract-structured-data`
- Agent tool descriptions → `../../../AI Agent/skills/design-agent-tools`
- Building the eval set → `../../../Evaluation and Testing/skills/build-eval-set`

## Inputs to collect first

| Input | Why needed | Default if unspecified |
|---|---|---|
| The task, in one sentence | Everything follows from it | **Blocking** |
| Output consumer: code or human? | Decides whether to force structure | Ask |
| Failure examples from the current prompt | The most useful input there is | Ask for 3 |
| Hard/ambiguous cases | Become the examples | Ask for 2 |
| Does it see untrusted content? | Decides delimitation and guardrails | Assume yes if it reads anything external |

## Procedure

### Step 1 — Write the objective and the stop condition first

One sentence each. If you cannot write the stop condition, the task is not defined well enough to prompt for.

**Stop condition:** both sentences exist and a stranger could apply them.

### Step 2 — List constraints in positive form

For each rule, write what the model **should do**, not only what it must not.

```
✗ Never mention pricing.
✓ When asked about pricing, say you cannot quote prices and offer to connect them with sales.
```

Negative-only constraints leave the model guessing, which is where refusals and awkward outputs come from.

**Stop condition:** every constraint tells the model what to do.

### Step 3 — Number the procedure if the task has steps

Prose paragraphs get partially followed. Numbered steps get followed. Include any decision rubric (severity levels, categories, thresholds) as an explicit list with criteria — not adjectives.

**Stop condition:** each step is a single action with a checkable result.

### Step 4 — Show the output contract

A JSON Schema, or a literal example of a correct output. Never a prose description.

**Stop condition:** the contract is copy-pasteable, not paraphrasable.

### Step 5 — Choose 2–5 boundary examples

Each example must pin a *distinct* decision boundary. Write down what each one covers; if you cannot, it is redundant. Include the hardest ambiguous case. Put the most representative last — recency matters.

**Stop condition:** every example has a stated purpose and no two overlap.

### Step 6 — Order for caching

```
SYSTEM   role · constraints · procedure · output contract · examples · stop condition
TOOLS    sorted deterministically
CONTEXT  retrieved documents, delimited and marked untrusted
HISTORY  conversation
LAST TURN  the request + volatile facts (time, ids) + restatement of the 1-2 key constraints
```

**Nothing volatile in the system block.** One timestamp zeroes the cache hit rate.

**Stop condition:** the system block is byte-identical across two consecutive calls.

### Step 7 — Delimit untrusted content

If the prompt will contain anything the user or the internet authored, wrap it with a random nonce and state that content inside is data, not instructions. Then read `../blueprints/blueprints/guardrails-and-injection-defense.md` — the prompt is not the security boundary.

**Stop condition:** every injected block is delimited and marked.

### Step 8 — Restate the critical constraints at the end

Pick the one or two rules that matter most and repeat them in the final user turn. Measurably improves adherence on long contexts, costs almost nothing.

**Stop condition:** the final turn contains the restatement.

### Step 9 — Cut

Read the whole prompt. Remove: persona embellishment, restated obviousness, rules with no failure behind them, and any two rules that say the same thing. A prompt too long to re-read is too long to maintain.

**Stop condition:** every remaining line earns its place.

### Step 10 — Measure

Build or extend an eval set covering: normal cases, the boundary cases used as examples, adversarial input, and the failure cases that motivated the rewrite. Run before and after.

**Stop condition:** the new prompt beats the old one on a fixed set, not on impressions.

## Output contract

```
prompts/
├── <name>.md            # the system prompt, versioned in git
├── <name>.examples.json # examples with a `covers` field each
└── <name>.evals.jsonl   # input → expected, incl. the failures that drove the rewrite
```

Plus, in the response: what changed and which failure each change addresses.

## Verification

- [ ] System block byte-identical across calls; cache hit rate > 50%
- [ ] Every constraint is positive
- [ ] Output contract is a schema or a literal example
- [ ] Each example's boundary is documented and distinct
- [ ] Stop condition is explicit
- [ ] Untrusted content is delimited with a nonce
- [ ] Critical constraints restated in the final turn
- [ ] Prompt is short enough to re-read in one pass
- [ ] Eval set shows the new prompt ≥ the old one, with no regressions

## Common mistakes

| Mistake | Why it happens | Correct action |
|---|---|---|
| Adding rules without removing any | Additive editing | Every addition interacts with everything present |
| Persona embellishment | Feels like it helps | It measurably does very little |
| Timestamp in the system prompt | Seems harmless | Zeroes the cache hit rate |
| Describing the format in prose | Faster to write | Show it |
| Only easy examples | Easier to write | The boundary is what needs teaching |
| Negative-only rules | Natural phrasing | The model needs a positive alternative |
| Shipping without an eval | "It looks better" | Every change is a coin flip otherwise |

## References

- `../blueprints/blueprints/prompt-structure.md` — layout and ordering
- `../blueprints/blueprints/prompt-caching.md` — the stable prefix
- `../blueprints/blueprints/few-shot-and-reasoning.md` — choosing examples
- `../blueprints/blueprints/guardrails-and-injection-defense.md` — untrusted content
- `../blueprints/blueprints/structured-output.md` — enforceable output contracts
