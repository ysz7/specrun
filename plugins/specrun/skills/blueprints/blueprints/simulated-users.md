+++
id = "simulated-users"
title = "Simulated users"
use_when = "Evaluating a multi-turn or conversational agent, or offline scores look good while production behaviour does not match them"
pack = "evaluation"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Simulated Users and the Offline–Production Gap

> Building eval users that behave like real ones — terse, impatient, ambiguous — instead of the
> articulate, cooperative personas an LLM produces by default.

**Tier:** intermediate
**Use when:** evaluating any multi-turn or conversational agent; or when offline scores are good
and production quality is not.
**Avoid when:** the system is single-turn with no user interaction to simulate.
**Cost profile:** one extra model call per simulated turn. Cheap relative to the cost of shipping
against a fantasy user.

---

## 1. Problem it solves

Ask a model to play a user and it produces a good writer: complete sentences, all the relevant
context volunteered up front, patient clarification when asked, polite acknowledgement of
progress.

Real users type "doesnt work". They answer a clarifying question with two words. They give the
order number wrong the first time. They change what they want halfway. They go quiet.

An agent tuned against the first population and deployed to the second fails in ways the eval set
cannot see — and the failure is systematic, not random. Teams routinely find their conversational
evals were unrealistic **because simulated users were too polite, too patient, too detailed.**

The fix is not "make the simulator better at being a user". It is to **specify the behaviours**
that make users hard, and hold the simulator to them.

## 2. Shape

```
  ┌──────────────── PERSONA (the constraints, not the backstory) ──────────────┐
  │  verbosity:        terse | normal | rambling                                │
  │  cooperativeness:  answers directly | partial | evasive                     │
  │  domain knowledge: expert | some | none                                     │
  │  patience:         high | low | abandons after N turns                      │
  │  accuracy:         correct facts | one wrong detail | contradicts self       │
  │  goal stability:   fixed | shifts mid-conversation                           │
  │  hidden goal:      what they actually want but did not say                   │
  └────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │ SIMULATOR                          ⟷                    AGENT UNDER TEST    │
  │  strictly in-persona                                                        │
  │  never volunteers unasked info                                              │
  │  may abandon                                                                │
  └────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │ SCORE: was the HIDDEN GOAL achieved? in how many turns? did the user leave? │
  │  — not "was the conversation pleasant"                                      │
  └────────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │ CALIBRATE against real transcripts: turn length, turns to resolution,       │
  │ clarification rate, abandonment rate. Distributions must MATCH.             │
  └────────────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Persona spec | The behavioural constraints | Typed object, not prose | A backstory instead of behaviours |
| Simulator prompt | Enforce the persona | Strong negative constraints | Drifts into being helpful |
| Hidden goal | What success means | Held by the harness, never shown to the agent | Leaked into the first message |
| Termination policy | When the user gives up | Turn cap + frustration trigger | Simulated users never abandon |
| Scorer | Goal achieved? turns? abandoned? | Deterministic where possible | Scoring conversation quality instead of outcome |
| Calibration set | Real transcripts | Production logs | Never collected, so realism is unverified |
| Distribution check | Simulated vs real statistics | Compare turn length, turn count, abandonment | Skipped |

## 4. Data flow

1. Sample a persona from a distribution that **matches production**, not a uniform one.
2. Assign a hidden goal and the facts the user knows — including any wrong ones.
3. Simulator produces an opening message in persona. Typically short and underspecified.
4. Agent responds. Simulator replies **in persona**: terse users stay terse; evasive users answer
   the wrong question; impatient users abandon.
5. Loop until the goal is achieved, the user abandons, or the turn cap is hit.
6. Score the **outcome**, not the transcript's tone.
7. Periodically compare simulated conversation statistics against real ones and adjust.

## 5. Contracts

```python
from pydantic import BaseModel, Field
from typing import Literal

class Persona(BaseModel):
    """Behavioural constraints. NOT a character backstory — that produces a novelist,
    not a difficult user."""
    verbosity: Literal["terse", "normal", "rambling"] = "terse"
    cooperativeness: Literal["direct", "partial", "evasive"] = "partial"
    domain_knowledge: Literal["expert", "some", "none"] = "none"
    patience_turns: int = Field(6, description="Abandons after this many unresolved turns.")
    factual_accuracy: Literal["correct", "one_error", "contradictory"] = "one_error"
    goal_stability: Literal["fixed", "shifts"] = "fixed"

class SimulatedCase(BaseModel):
    id: str
    persona: Persona
    hidden_goal: str = Field(description="What they actually want. Never shown to the agent.")
    known_facts: dict[str, str] = Field(description="What the user can supply IF ASKED.")
    wrong_facts: dict[str, str] = Field(default_factory=dict,
        description="What they will state incorrectly unless corrected.")
    opening_message: str | None = Field(None, description="Fixed opener, or generated in persona.")

class ConversationResult(BaseModel):
    case_id: str
    goal_achieved: bool
    turns: int
    abandoned: bool
    abandonment_turn: int | None
    agent_asked_clarification: int
    wrong_fact_corrected: bool
```

## 6. Reference implementation

The simulator prompt is the whole technique. Negative constraints do the work:

```python
SIMULATOR_SYSTEM = """You are simulating a real user contacting support. You are NOT an
assistant and you are NOT trying to make this easy.

YOUR SITUATION
Goal: {hidden_goal}
Facts you know: {known_facts}
Facts you believe but are WRONG about: {wrong_facts}

HOW YOU BEHAVE
- Verbosity: {verbosity}. If terse, most replies are under 8 words. "no", "still broken",
  "the second one" are complete replies.
- Cooperativeness: {cooperativeness}. If partial, answer only part of what was asked.
  If evasive, answer a different question than the one asked.
- Knowledge: {domain_knowledge}. If none, you do not know the product's terminology and
  will describe things wrongly.
- Accuracy: {factual_accuracy}. If one_error, state one wrong fact confidently and only
  correct it if the agent challenges it directly.

HARD RULES
- NEVER volunteer information that was not asked for. Real users do not.
- NEVER restate your goal clearly unless directly asked. Your first message is vague.
- NEVER thank the agent for progress or acknowledge that it is being helpful.
- NEVER use complete, well-structured sentences unless your verbosity is `rambling`.
- If nothing useful has happened for {patience_turns} turns, write exactly:
  "forget it" and stop.
- Do not break character to explain yourself. You are a user, not an evaluator.

Reply with your next message and nothing else."""


async def run_conversation(case: SimulatedCase, agent, max_turns: int = 15):
    history, frustration = [], 0
    msg = case.opening_message or await simulate_opening(case)

    for turn in range(max_turns):
        history.append(("user", msg))
        reply = await agent.respond(history)
        history.append(("agent", reply))

        if goal_achieved(case.hidden_goal, history):
            return ConversationResult(case_id=case.id, goal_achieved=True, turns=turn + 1,
                                      abandoned=False, abandonment_turn=None,
                                      agent_asked_clarification=count_questions(history),
                                      wrong_fact_corrected=corrected(case, history))

        frustration = 0 if made_progress(history) else frustration + 1
        if frustration >= case.persona.patience_turns:
            return ConversationResult(case_id=case.id, goal_achieved=False, turns=turn + 1,
                                      abandoned=True, abandonment_turn=turn + 1,
                                      agent_asked_clarification=count_questions(history),
                                      wrong_fact_corrected=False)
        msg = await simulate_reply(case, history)

    return ConversationResult(case_id=case.id, goal_achieved=False, turns=max_turns,
                              abandoned=False, abandonment_turn=None,
                              agent_asked_clarification=count_questions(history),
                              wrong_fact_corrected=False)
```

Calibration is the step that makes any of this trustworthy:

```python
def calibrate(sim_results, real_transcripts) -> dict:
    """If these distributions do not match, your eval is measuring a different product."""
    return {
        "mean_user_words":  (mean(user_words(sim_results)), mean(user_words(real_transcripts))),
        "median_turns":     (median(turns(sim_results)),    median(turns(real_transcripts))),
        "abandonment_rate": (rate(sim_results, "abandoned"), rate(real_transcripts, "abandoned")),
        "clarifications":   (mean(clarifs(sim_results)),    mean(clarifs(real_transcripts))),
    }
    # Target: each simulated value within ±25% of the real one.
    # Almost always wrong on the first attempt: simulated users write 3-5x more words.
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Persona distribution | matches production | Realism | Never uniform — sample real proportions |
| Default verbosity | terse | Difficulty | Terse is the realistic default, not normal |
| `patience_turns` | 6 | Abandonment rate | Calibrate against real abandonment |
| `factual_accuracy` | `one_error` | Robustness testing | Real users misremember order numbers constantly |
| Hidden goal visibility | never to the agent | Validity | Leaking it makes every case trivial |
| Simulator model | fast tier | Cost | Persona adherence matters more than eloquence |
| Turn cap | 15 | Runaway conversations | Below the point where a real user would have left |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Eval scores high, production poor | Simulated users too cooperative | Compare word counts: simulated vs real | Enforce terseness; forbid volunteering |
| Simulator explains its own persona | Drifts out of character | Read transcripts | "Do not break character" + reject meta-commentary |
| Every conversation resolves | No abandonment path | Abandonment rate 0% | Patience counter with a hard exit |
| Agent looks great at clarifying | Simulator answers clarifications perfectly | Real users answer in 2 words | `cooperativeness: partial` as default |
| Wrong-fact handling untested | All simulated facts are correct | No case has a wrong fact | `factual_accuracy: one_error` in most personas |
| Personas are backstories | Prompt describes a character, not behaviours | Read the persona spec | Typed behavioural constraints only |
| Same three conversations repeatedly | Persona distribution too narrow | Transcript diversity | Sample from production proportions |
| Never recalibrated | Product changed, personas did not | Calibration date | Recalibrate quarterly and after major changes |

## 9. Anti-patterns

- **Letting the simulator be helpful.** It is the default failure and it invalidates everything
  downstream.
- **Backstories instead of behaviours.** "Maria is a 34-year-old teacher" changes nothing.
  "Replies in under 8 words, never volunteers information" changes everything.
- **No abandonment.** Real users leave; an agent that is slow but eventually correct scores
  perfectly in an eval where nobody can quit.
- **Leaking the hidden goal.** Every case becomes trivial and the eval measures nothing.
- **Scoring conversation quality.** Score whether the goal was achieved and in how many turns.
- **Uniform persona sampling.** Match production, or you optimise for a population you do not have.
- **Never calibrating against real transcripts.** Then the realism claim is unverified.
- **All-correct facts.** Real users misremember, and handling that is a real capability.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Word-count ratio | Simulated user words / real user words | 0.8–1.25 | > 2.0 |
| Turn-count ratio | Simulated median turns / real median | 0.8–1.25 | > 1.5 |
| Abandonment-rate gap | Simulated vs real | within 5 pts | > 15 pts |
| Goal achievement | Cases where the hidden goal was met | Product baseline | Below the real resolution rate |
| Persona adherence | Turns staying in character (audited) | ≥ 95% | < 85% |
| Offline–online gap | Eval success minus production success | < 10 pts | > 25 pts |
| Calibration age | Days since last calibration | < 90 | > 180 |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | Static single-turn eval questions |
| v1 | Multi-turn agent | Simulated conversations with a hidden goal |
| v2 | Eval and production disagree | Behavioural personas; terse default; abandonment |
| v3 | Realism unverified | Calibration against real transcripts |
| v4 | Product diversity | Persona distribution sampled from production |
| v5 | Continuous | Replay real transcripts as cases; recalibrate on a schedule |

## 12. Build checklist

- [ ] Personas are typed behavioural constraints, not backstories.
- [ ] Default verbosity is terse; the simulator is forbidden from volunteering information.
- [ ] The simulator is explicitly forbidden from thanking, acknowledging, or breaking character.
- [ ] Every case has a hidden goal that is never shown to the agent.
- [ ] Most personas include one incorrect fact.
- [ ] An abandonment path exists with a patience counter.
- [ ] Scoring is on outcome — goal achieved, turns, abandoned — not on tone.
- [ ] The persona distribution matches production proportions.
- [ ] Simulated conversation statistics are calibrated against real transcripts within ±25%.
- [ ] The offline–online gap is measured and tracked.
- [ ] Calibration is dated and scheduled.

## 13. Related

- [eval-harness-design.md](eval-harness-design.md) — the surrounding harness
- [agent-trajectory-eval.md](agent-trajectory-eval.md) — grading the path, not just the outcome
- [llm-as-judge.md](llm-as-judge.md) — judging goal achievement
- [regression-and-ci-evals.md](regression-and-ci-evals.md) — where these cases run
