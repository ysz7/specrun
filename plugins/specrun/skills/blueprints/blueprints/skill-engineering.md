+++
id = "skill-engineering"
title = "Skill engineering"
use_when = "Writing the markdown procedures an agent loads on demand — skills, playbooks, the instructions that keep being pasted into chat by hand"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Skill Engineering

<!-- verified: 2026-08-12 -->

> Writing the Markdown procedures that agents load on demand — where the engineering is in the
> triggering description, the decision boundaries, and the stop conditions, not the prose.

**Tier:** intermediate
**Use when:** the same instructions get pasted into a chat more than twice; a procedure must be
identical across a team; a checklist has to survive turnover.
**Avoid when:** the instruction is a single sentence, or it applies to exactly one task once.
**Cost profile:** the `description` is loaded for every skill at startup (~100 tokens each). The
body costs nothing until the skill fires.

---

## 1. Problem it solves

Every agent platform converged on the same artifact in 2026: a Markdown file describing a
procedure, loaded only when relevant. Teams now maintain skill libraries the way they used to
maintain orchestration code — which means skills have become a thing you can write *badly*.

The three failure modes are specific and none of them are about writing quality:

1. **It never fires.** The description does not contain the words a user actually types.
2. **It fires on the wrong things.** The description is broad, so it captures adjacent tasks and
   makes them worse.
3. **It fires and the agent still improvises.** The body describes a topic instead of a procedure
   with stop conditions.

The economics matter too: descriptions are resident for every installed skill. Twenty skills with
sprawling descriptions is a permanent context tax on every conversation.

## 2. Shape

```
  ┌─── frontmatter — RESIDENT, ~100 tokens, loaded for EVERY skill at startup ───┐
  │ name:        must equal the folder name                                      │
  │ description: WHAT it does + WHEN to use it + the words users actually type   │
  └──────────────────────────────┬──────────────────────────────────────────────┘
                                 │ agent decides this matches the task
                                 ▼
  ┌─── body — loaded ONLY on activation, target < 500 lines ────────────────────┐
  │  When this applies      2-4 concrete triggers                                │
  │  Do NOT use for         adjacent tasks → names the other skill               │
  │  Inputs to collect      table; what is blocking, what has a default          │
  │  Procedure              numbered steps, each with a STOP CONDITION           │
  │  Output contract        exact files/format produced                          │
  │  Verification           checks the agent runs on itself                      │
  │  Common mistakes        mistake / why it happens / correct action            │
  └──────────────────────────────┬──────────────────────────────────────────────┘
                                 │ only if genuinely needed
                                 ▼
  ┌─── references/ scripts/ assets/ — loaded on demand ─────────────────────────┐
  └─────────────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Constraint | Primary failure mode |
|---|---|---|---|
| `name` | Identity and slash command | 1–64 chars, `a-z0-9-`, equals folder name | Mismatch with folder → does not load |
| `description` | **The entire triggering signal** | 1–1024 chars | Written as a title, not as trigger conditions |
| "When this applies" | Confirms the match | 2–4 concrete cases | Vague restatement of the description |
| "Do not use for" | Prevents over-firing | Names the alternative skill | Missing → the skill captures adjacent tasks |
| Inputs table | What to gather before acting | Mark blocking vs defaulted | Agent starts without the one thing it needs |
| Procedure | Ordered steps | Each has a stop condition | Prose paragraphs the agent half-follows |
| Stop conditions | How the agent knows a step is done | Observable, not "carefully consider" | Absent → steps merge and get skipped |
| Output contract | What is produced | Exact paths and formats | Agent invents its own structure |
| Verification | Self-check before declaring done | Checkable statements | "Make sure it's good" |
| Common mistakes | Failure table | Mistake / why / correct action | Generic advice |

## 4. Data flow

1. At startup the agent loads every installed skill's `name` + `description`. Nothing else.
2. A user task arrives. The agent matches it against those descriptions.
3. On a match, the **whole body** is loaded into context.
4. The agent follows the procedure, using stop conditions to know when each step is complete.
5. `references/` and `scripts/` are read only if the body points at them.
6. Verification runs before the agent reports done.

Two consequences follow directly: the description is the only thing that decides whether a skill
is ever used, and the body must be self-sufficient because it arrives with no other explanation.

## 5. Contracts

```yaml
---
name: diagnose-rag-failure          # == folder name; a-z0-9-; ≤64 chars
description: >
  Localises a wrong RAG answer to a specific stage — retrieval miss, ranking failure, or
  generation failure — by checking each stage against evidence rather than guessing. Use when
  a RAG system returns a wrong or incomplete answer, hallucinates despite having documents,
  says it cannot find something that exists, cites the wrong source, or when retrieval quality
  regressed after a change.
compatibility: Requires access to the index and an eval set.   # only if genuinely required
allowed-tools: Bash(git:*) Read Grep                            # optional, experimental
metadata:
  version: "1.0"
---
```

The description has a shape worth copying:

```
<Capability: what it does, stated as an action.>
Use when <trigger 1>, <trigger 2>, <trigger 3>, or <trigger 4>.
```

Triggers must be **the words a user types**, not your internal vocabulary. "Hallucinates despite
having documents" is a trigger. "Grounding fidelity degradation" is not — nobody types that.

## 6. Reference implementation

Description quality decides everything, so it is worth seeing the difference:

```yaml
# ✗ Never fires — a title, not a trigger set
description: Helps with RAG debugging.

# ✗ Fires on everything adjacent, degrading unrelated tasks
description: Use this skill for anything involving retrieval, search, documents,
  embeddings, vector databases, or answering questions.

# ✓ Specific capability + the words users actually type
description: Localises a wrong RAG answer to a specific stage — retrieval miss, ranking
  failure, or generation failure — by checking each stage against evidence. Use when a RAG
  system returns a wrong answer, hallucinates despite having documents, says it cannot find
  something that exists, cites the wrong source, or when quality regressed after a change.
```

Procedure steps need stop conditions, or they blur together:

```markdown
### Step 3 — Is it retrieved for the real question?

Run the actual user question. Record the gold chunk's rank across the full candidate set,
before reranking and before truncation to k.

| Rank | Class | Go to |
|---|---|---|
| Not in top-50 | RETRIEVAL MISS | Step 4 |
| In top-50, not top-k | RANKING FAILURE | Step 5 |
| In the top-k sent to the model | GENERATION FAILURE | Step 6 |

**Stop condition:** exactly one class, with the rank recorded as a number.
```

Compare with what does not work: *"Step 3 — Analyse the retrieval results carefully and
determine the likely cause."* There is nothing to check, so the agent decides it is done.

Testing a skill is ordinary work:

```python
SHOULD_FIRE = [
    "the rag keeps giving wrong answers",
    "it says it can't find the policy doc but it's definitely there",
    "search got worse after we changed the chunking",
]
SHOULD_NOT_FIRE = [
    "set up a vector database",          # → build-rag-pipeline
    "write me an eval set",              # → build-rag-evalset
    "why is my API slow",                # → unrelated
]
```

Run these against the real agent with the skill installed. Firing accuracy is measurable, and it
is the single number that matters most.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Description length | 300–600 chars | Trigger coverage vs resident cost | Longer only if real trigger phrases are missing |
| Body length | < 500 lines | Context on activation | Move detail to `references/` |
| Scope | 1 skill = 1 job | Firing precision | Split when "do not use for" grows past 3 entries |
| `references/` | only when needed | Progressive loading | Detail read on demand, not always |
| `scripts/` | only when deterministic | Reliability | Prefer a script to prose for anything mechanical |
| `allowed-tools` | omit | Pre-approval | Only when the tool set is genuinely fixed |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Skill never fires | Description lacks the words users type | Firing test set | Rewrite from real user phrasings |
| Fires on unrelated tasks | Description too broad | Should-not-fire set | Narrow it; add "do not use for" naming the alternative |
| Fires but the agent improvises | Body is a topic, not a procedure | Read the transcript | Numbered steps with stop conditions |
| Two skills compete | Overlapping descriptions | Firing confusion matrix | Mutual "do not use for" clauses, or merge them |
| Startup context is heavy | Many long descriptions | Sum description tokens | Trim to trigger-essential wording |
| Agent stops mid-procedure | No stop conditions | Incomplete outputs | Every step ends with an observable condition |
| Output shape varies per run | No output contract | Compare two runs | Exact paths and formats in the body |
| Skill rots | Nobody re-runs the firing test | Accuracy drops silently | Firing tests in CI |

## 9. Anti-patterns

- **Description as a title.** "Helps with X" carries no trigger information. It is the only signal
  the agent has.
- **Internal vocabulary in triggers.** Users type "it's slow", not "p99 latency regression".
- **No "do not use for".** Skills expand to fill adjacent tasks and make them worse.
- **Steps with no stop condition.** "Carefully review the output" is unverifiable, so it is skipped.
- **One skill doing three jobs.** Firing becomes ambiguous and the body becomes unreadable.
- **Everything in the body.** Long reference material belongs in `references/`, loaded on demand.
- **Prose where a script would do.** If it is mechanical, ship a script and call it.
- **Never testing firing.** The most important property of a skill is untested by default.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Firing precision | Fires when it should / all firings | ≥ 90% | < 75% |
| Firing recall | Fires when it should / should-fire cases | ≥ 90% | < 70% |
| Description tokens | Per skill | 80–150 | > 250 |
| Body length | Lines | < 500 | > 800 |
| Procedure completion | Runs completing every step | ≥ 95% | < 80% |
| Output conformance | Outputs matching the contract | ≥ 95% | < 80% |
| Total resident cost | Sum of all installed descriptions | < 2 500 tokens | > 5 000 |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | Instructions pasted into chat |
| v1 | Pasted a third time | A skill with frontmatter and a numbered procedure |
| v2 | It fires wrongly | Firing test set; description rewritten from real phrasings |
| v3 | Body exceeds 500 lines | Split into `references/` |
| v4 | Steps are mechanical | `scripts/` invoked from the procedure |
| v5 | A library, several authors | Conventions doc, firing tests in CI, ownership per skill |

## 12. Build checklist

- [ ] `name` equals the folder name and matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
- [ ] The description states the capability **and** four trigger phrases users would actually type.
- [ ] A "do not use for" section names the alternative skill.
- [ ] Inputs are tabled, with blocking ones marked.
- [ ] Every procedure step ends with an observable stop condition.
- [ ] An output contract states exact paths and formats.
- [ ] A verification section lists checks the agent runs on itself.
- [ ] A common-mistakes table gives mistake / why / correct action.
- [ ] Body is under 500 lines; long detail is in `references/`.
- [ ] Mechanical steps are scripts, not prose.
- [ ] A firing test set exists with should-fire and should-not-fire cases, and runs in CI.
- [ ] The skill's description was checked against every other installed skill for overlap.

## 13. Related

- [tool-design.md](tool-design.md) — the same discipline applied to tool descriptions
- [prompt-structure.md](prompt-structure.md) — writing the body
- [eval-harness-design.md](eval-harness-design.md) — the firing test harness
