+++
id = "context-engineering"
title = "Context engineering"
use_when = "Deciding what occupies the model's context on a long run: the agent forgets what was said early on, quality falls off as the run grows, or cost is dominated by re-sending history"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Context Engineering

> The discipline of deciding what occupies the model's finite attention at each step — and what gets summarised, offloaded to disk, or delegated to a sub-agent instead.

**Tier:** intermediate
**Use when:** tasks exceed ~40% of the context window; quality degrades on long runs; cost is dominated by re-sending history.
**Avoid when:** every task finishes in under ~10 turns and well inside the window — the machinery adds failure modes for no gain.
**Cost profile:** compaction costs one extra LLM call per trigger; typically saves 40–80% of tokens on long runs.

---

## 1. Problem it solves

Context is a finite budget with diminishing returns, not a bucket to fill. Two independent problems appear as runs grow:

1. **Hard limit.** History exceeds the window and the request fails.
2. **Context rot.** Well before the limit, recall of any single fact degrades as tokens accumulate. An agent 60 turns in "forgets" the constraint stated in turn 3 even though it is verbatim in context.

The naive fixes — bigger window, "remember the constraints" reminders — treat the symptom. Context engineering treats the budget as an engineering resource: measure it, bound it, and move information out of the window when it is not needed *this turn*.

## 2. Shape

```
  ┌────────────────────────── context window ──────────────────────────┐
  │ [ system prompt ]  stable prefix ─────────────── cacheable ────────│
  │ [ tool schemas  ]  stable prefix ─────────────── cacheable ────────│
  │ [ memory recall ]  read from disk on demand ──── semi-stable ──────│
  │ [ compacted summary of turns 1..N-k ] ───────── rewritten on trig ─│
  │ [ recent turns N-k..N verbatim ] ────────────── volatile ──────────│
  │ [ current user turn ] ─────────────────────────────────────────────│
  └────────────────────────────────────────────────────────────────────┘
        │                                     ▲
        │ offload                             │ retrieve
        ▼                                     │
  ┌──────────────┐   ┌──────────────┐   ┌─────┴────────┐
  │ NOTES.md     │   │ artifacts/   │   │  sub-agent   │  returns 1–2k tokens
  │ (durable     │   │ (files the   │   │  own window, │  not its 100k of
  │  decisions)  │   │  agent made) │   │  own tools   │  intermediate work
  └──────────────┘   └──────────────┘   └──────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Token accountant | Measure occupancy per segment every turn | Tokenizer + counters | Absent → you optimise blind |
| Stable prefix | Keep system + tools byte-identical | Static assembly | Injecting a timestamp kills cache hits |
| Compactor | Summarise old turns into a structured brief | LLM call with a fixed schema | Free-form summary drops the constraints |
| Memory store | Durable facts across compactions and sessions | `NOTES.md`, key-value, DB | Write-only memory nobody reads |
| Artifact store | Big outputs live as files, referenced by path | Filesystem, object store | Contents pasted back into context |
| Sub-agent boundary | Isolate exploratory token burn | Separate loop + window | Returning the full transcript, defeating the point |
| Retrieval hook | Pull only the memory relevant to this turn | grep / embeddings | Loading all memory every turn |

## 4. Data flow

1. Before each LLM call, count tokens per segment.
2. If total > `compact_threshold` (fraction of window): run the compactor over the oldest turns, keeping the last `k` verbatim.
3. Compactor emits a **structured** brief: goal, decisions made, constraints, files touched, open questions, next step.
4. Replace the summarised turns with the brief; keep the stable prefix untouched.
5. Anything that must survive the *next* compaction is written to `NOTES.md` by the agent before step 2 (guaranteed by a pre-compaction hook or an explicit instruction).
6. Large tool outputs are written to `artifacts/` and only the path plus a 3-line description enters context.
7. Open-ended exploration (`"find where X is implemented"`) is delegated to a sub-agent whose entire window is discarded; only its conclusion returns.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class ContextBudget(BaseModel):
    window_tokens: int = 200_000
    compact_at: float = 0.55          # fraction of window
    keep_recent_turns: int = 6
    max_tool_result_tokens: int = 2_000
    reserve_for_output: int = 8_000

class CompactionBrief(BaseModel):
    """Fixed schema. Free-form summaries lose constraints — do not use prose."""
    goal: str
    constraints: list[str] = Field(description="Verbatim user requirements. Never paraphrase.")
    decisions: list[str] = Field(description="What was decided and why, one line each.")
    artifacts: list[str] = Field(description="Paths written, with one-line contents.")
    findings: list[str] = Field(description="Facts discovered that are not re-derivable cheaply.")
    open_questions: list[str]
    next_step: str
    discarded: list[str] = Field(description="What was dropped, so the model knows it can re-fetch.")

class SubAgentResult(BaseModel):
    answer: str                       # ≤ 2 000 tokens
    evidence: list[str]               # file:line or URL, not pasted content
    confidence: float
```

## 6. Reference implementation

```python
import json
from anthropic import Anthropic

client = Anthropic()

COMPACT_SYSTEM = """You compress an agent transcript into a structured brief.

Rules:
- Copy user constraints VERBATIM into `constraints`. Never paraphrase or merge them.
- `findings` holds only facts that would cost tool calls to re-derive.
- Do not include reasoning, apologies, or narration.
- `discarded` lists what you dropped so the agent knows it can re-fetch it.
Return JSON matching the CompactionBrief schema and nothing else."""

def compact(messages: list[dict], budget: ContextBudget) -> list[dict]:
    keep = messages[-budget.keep_recent_turns:]
    old = messages[:-budget.keep_recent_turns]
    if not old:
        return messages

    resp = client.messages.create(
        model="<FAST_MODEL_ID>",              # compaction does not need the frontier model
        max_tokens=2048,
        system=COMPACT_SYSTEM,
        messages=[{"role": "user", "content": json.dumps(old, default=str)}],
    )
    brief = CompactionBrief.model_validate_json(resp.content[0].text)

    anchor = {"role": "user", "content":
              "[COMPACTED CONTEXT — earlier turns were summarised]\n"
              + brief.model_dump_json(indent=2)
              + "\n[END COMPACTED CONTEXT]"}
    return [anchor, *keep]

def maybe_compact(messages, budget, count_tokens):
    used = count_tokens(messages)
    if used > budget.compact_at * (budget.window_tokens - budget.reserve_for_output):
        return compact(messages, budget), True
    return messages, False
```

Offloading a large tool result:

```python
def offload(name: str, content: str, budget: ContextBudget) -> str:
    """Write big results to disk; return a pointer plus a preview."""
    if count_tokens(content) <= budget.max_tool_result_tokens:
        return content
    path = f"artifacts/{name}.txt"
    Path(path).write_text(content)
    head = content[:800]
    return (f"[{len(content)} chars written to {path}]\n"
            f"First 800 chars:\n{head}\n"
            f"Use read_file with a line range to read more.")
```

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| `compact_at` | 0.55 of window | When compaction fires | Lower to 0.4 if quality degrades before the limit |
| `keep_recent_turns` | 6 | Verbatim tail | Raise when the task needs fine detail of recent steps |
| `max_tool_result_tokens` | 2 000 | Offload threshold | Lower with many parallel tools |
| Compaction model | fast/cheap tier | Cost of compaction | Use the frontier model if briefs lose constraints |
| Memory read policy | on demand (grep) | Tokens spent on memory | Never "load all memory each turn" |
| Sub-agent return cap | 2 000 tokens | Isolation benefit | Raise only if the parent must re-verify |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Agent violates a constraint stated 40 turns ago | Compaction paraphrased it away | Constraint-recall eval after forced compaction | Verbatim `constraints` field; assert it survives every compaction |
| Agent redoes work it already did | Findings not carried forward | Duplicate tool-call detection across compaction boundary | Persist `findings` and `artifacts` to `NOTES.md` |
| Cost stays high despite compaction | Stable prefix mutates → cache misses | Cache-hit-rate metric | Freeze system + tool block; move volatile facts to the last user turn |
| Compaction loop (summary of summary of summary) | Threshold too low, tail too short | Count compactions per run | Raise `compact_at`, raise `keep_recent_turns` |
| Sub-agent output useless | Task passed without enough context | Manual trace read | Give the sub-agent a self-contained brief; it shares no history |
| Memory file grows to 50 KB | Append-only, never curated | File size over time | Cap size; the agent rewrites/prunes rather than appends |
| Quality drops at 60% window with room to spare | Context rot | Accuracy vs occupancy plot | Compact earlier; offload more aggressively |

## 9. Anti-patterns

- **"Just use a bigger window."** Rot is about attention dilution, not capacity. Bigger windows raise the ceiling, not the quality curve.
- **Free-form compaction.** "Summarise the conversation so far" reliably drops exactly the hard constraints. Use a fixed schema with a verbatim constraints field.
- **Loading the entire memory file every turn.** Memory should be retrieved, not resident.
- **Sub-agents that return their transcript.** The whole benefit is discarding the intermediate tokens.
- **Injecting `datetime.now()` into the system prompt.** Guarantees a 0% cache-hit rate. Put the timestamp in a tool result.
- **Compaction with no pre-hook.** The agent never gets a chance to persist what matters before its context is rewritten.
- **Counting characters instead of tokens.** Off by 3–4× and differs per language; use the real tokenizer.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Peak context occupancy | max tokens / window per run | < 70% | > 90% |
| Cache hit rate | cached input / total input tokens | > 70% | < 40% |
| Compactions per run | count | ≤ 2 | ≥ 5 |
| Constraint recall after compaction | scored eval, post-forced-compaction | 100% | < 95% |
| Tokens per successful task | p50 / p95 | product-specific baseline | p95 > 3× p50 |
| Post-compaction success delta | success rate after vs before compaction | ≥ −2 pts | ≤ −10 pts |

## 11. Scaling path

| Stage | Trigger to move up | What changes |
|---|---|---|
| v0 | — | Full history, tool-result truncation only |
| v1 | Runs hit 50% of window | Token accounting + structured compaction |
| v2 | Facts lost across compactions | `NOTES.md` memory + pre-compaction persist hook |
| v3 | Exploration dominates token spend | Sub-agents with isolated windows |
| v4 | Multi-session continuity needed | Retrieval-backed memory ([RAG](agentic-rag.md)), session-scoped indices |

## 12. Build checklist

- [ ] Tokens are counted with the real tokenizer, per segment, every turn.
- [ ] The system + tools prefix is byte-stable across all turns of a run.
- [ ] Compaction emits a fixed schema; `constraints` are copied verbatim.
- [ ] A pre-compaction hook lets the agent persist findings first.
- [ ] Tool results above threshold are written to `artifacts/` and referenced by path.
- [ ] Memory is retrieved on demand, never loaded wholesale.
- [ ] Sub-agents return ≤ 2 000 tokens with pointers, not pasted content.
- [ ] An eval measures constraint recall across a forced compaction.
- [ ] Cache hit rate is monitored and alerts below 40%.
- [ ] Memory files have a size cap and a prune policy.

## 13. Related

- [agent-loop.md](agent-loop.md) — where the budget is spent
- [memory-architecture.md](memory-architecture.md) — durable state across sessions
- [orchestrator-workers.md](orchestrator-workers.md) — sub-agents as a context strategy
- [prompt-caching.md](prompt-caching.md) — the economics of the stable prefix
