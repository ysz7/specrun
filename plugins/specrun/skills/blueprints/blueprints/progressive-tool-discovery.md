+++
id = "progressive-tool-discovery"
title = "Progressive tool discovery"
use_when = "The agent has more than about fifteen tools, tool schemas dominate the prompt, or accuracy drops with every tool added"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Progressive Tool Discovery

> Loading tool definitions on demand instead of putting all of them in every prompt — so an agent
> can reach hundreds of capabilities while only ever seeing the dozen that matter now.

**Tier:** advanced
**Use when:** the agent needs more than ~15 tools, or tool schemas already cost more than ~3 000
tokens per turn, or selection accuracy is falling as tools are added.
**Avoid when:** under 15 tools. A flat list is simpler, cheaper to reason about, and works.
**Cost profile:** +1 cheap call per discovery step. Usually net-negative cost because the flat
schema block disappears from every turn.

---

## 1. Problem it solves

Tool schemas are paid **on every single turn**, whether used or not. Forty tools at 150 tokens
each is 6 000 tokens of tax per turn, and it buys worse behaviour: selection accuracy degrades
as the candidate set grows, because the model is choosing between many similar-looking options
under attention dilution.

The pattern reported repeatedly in 2026 production write-ups is the same shape: v1 worked with a
handful of tools; v2 added twenty-plus per domain and reasoning degraded; v3 recovered by making
tools **discoverable rather than resident**.

The insight: an agent does not need to *see* a tool to be able to *reach* it. It needs to know
the tool exists, in one line, and be able to load its full definition when it decides to use it.

**Try the cheaper fixes first.** Merging endpoint-shaped tools into task-shaped ones
([tool-design.md](tool-design.md)) and splitting by [routing](routing.md) both
reduce tool count without new machinery. Progressive discovery is what you do when you genuinely
need breadth.

## 2. Shape

```
  ┌─────────────── TIER 1 — always resident (~400 tokens) ────────────────┐
  │  4 core tools the agent always needs                                   │
  │  + list_capabilities(domain?)   ← the discovery entry point            │
  │  + load_tools(names[])          ← pulls full schemas into this session  │
  └────────────────────────────────┬──────────────────────────────────────┘
                                   │ agent calls list_capabilities("billing")
                                   ▼
  ┌─────────────── TIER 2 — one-line summaries (~30 tokens each) ─────────┐
  │  billing_search_invoices   — find invoices by customer, date, status   │
  │  billing_issue_credit      — credit an invoice (irreversible)          │
  │  billing_get_payment       — payment status and method for an invoice  │
  │  … returned as a RESULT, not resident in the prompt                    │
  └────────────────────────────────┬──────────────────────────────────────┘
                                   │ agent calls load_tools(["billing_search_invoices"])
                                   ▼
  ┌─────────────── TIER 3 — full schema, now callable ────────────────────┐
  │  complete JSON Schema, field descriptions, examples                    │
  │  stays loaded for the rest of this run (or until evicted)              │
  └───────────────────────────────────────────────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Typical tech | Primary failure mode |
|---|---|---|---|
| Tier-1 set | Tools needed on almost every task, plus discovery | Static list, ≤ 6 | Grows over time until it is a flat list again |
| Capability index | Domain → one-line summaries | Dict, or embeddings for semantic lookup | Summaries too vague to choose from |
| `list_capabilities` | Return summaries for a domain or query | Tool | Returns everything, defeating the point |
| `load_tools` | Attach full schemas to this session | Tool + session tool registry | No cap, so the agent loads all of them |
| Session tool set | Which tools are currently callable | Per-run mutable registry | Not reset between runs |
| Eviction | Drop unused loaded tools | LRU or explicit | Absent → context creeps back up |
| Domain taxonomy | How capabilities are grouped | Config | Overlapping domains make discovery ambiguous |

## 4. Data flow

1. Run starts with tier-1 tools only.
2. Agent hits something it cannot do and calls `list_capabilities(domain)` — or with a free-text
   need, if the index supports semantic lookup.
3. It receives one-line summaries **as a tool result**, not as resident schemas. This is the key
   economic move: summaries are paid once, not every turn.
4. Agent calls `load_tools([...])` with the names it wants. Cap enforced server-side.
5. Those schemas join the session's tool set and are available for the rest of the run.
6. Optional: evict tools unused for N steps, to keep long runs bounded.
7. Trace every discovery and load — this is how you learn which tools deserve promotion to tier 1.

## 5. Contracts

```python
from pydantic import BaseModel, Field

class CapabilitySummary(BaseModel):
    name: str
    domain: str
    summary: str = Field(max_length=120,
        description="One line. Must be enough to decide whether to load it. "
                    "'Find invoices by customer, date, status' — not 'invoice operations'.")
    irreversible: bool = Field(description="Surfaced early so the agent can plan around gates.")

class DiscoveryConfig(BaseModel):
    tier1_tools: list[str] = Field(max_length=6)
    max_loaded_tools: int = Field(12, description="Hard cap on tier-3 schemas per run.")
    max_summaries_returned: int = Field(20, description="Cap on a single list_capabilities call.")
    evict_after_unused_steps: int | None = 15
```

## 6. Reference implementation

```python
class SessionTools:
    """Tool set is per-run and mutable. This is the whole mechanism."""
    def __init__(self, registry: dict, cfg: DiscoveryConfig):
        self.registry, self.cfg = registry, cfg
        self.loaded = set(cfg.tier1_tools)
        self.last_used: dict[str, int] = {}

    def schemas(self) -> list[dict]:
        return [self.registry[n].schema for n in self.loaded]

    def load(self, names: list[str], step: int) -> str:
        unknown = [n for n in names if n not in self.registry]
        if unknown:
            return (f"Unknown tools: {unknown}. Call list_capabilities first to see what "
                    f"exists — do not guess names.")
        room = self.cfg.max_loaded_tools - len(self.loaded)
        if len(names) > room:
            self._evict(step)
            room = self.cfg.max_loaded_tools - len(self.loaded)
            if len(names) > room:
                return (f"Cannot load {len(names)} tools; only {room} slots free. "
                        f"Load the ones you need for the immediate next step.")
        self.loaded.update(names)
        for n in names:
            self.last_used[n] = step
        return (f"Loaded: {', '.join(names)}. Their full schemas are now available. "
                f"{self.cfg.max_loaded_tools - len(self.loaded)} slots remaining.")

    def _evict(self, step: int):
        if self.cfg.evict_after_unused_steps is None:
            return
        stale = [n for n in self.loaded
                 if n not in self.cfg.tier1_tools
                 and step - self.last_used.get(n, 0) > self.cfg.evict_after_unused_steps]
        self.loaded -= set(stale)


# ---- tier-1 discovery tools ----
def list_capabilities(domain: str | None = None, need: str | None = None) -> str:
    """List available capabilities. Call this when you need to do something you have no tool for.

    domain: one of billing, orders, shipping, accounts, reporting. Omit to list domains only.
    need:   free-text description of what you are trying to do; returns the closest matches.
    Returns one-line summaries. Use load_tools to get the full schema for the ones you want.
    """
    if domain is None and need is None:
        return ("Domains: billing, orders, shipping, accounts, reporting.\n"
                "Call again with a domain, or with need='what you are trying to do'.")
    matches = index.search(domain=domain, need=need, limit=CFG.max_summaries_returned)
    if not matches:
        return (f"No capabilities matched. Available domains: {index.domains()}. "
                f"If nothing fits, say so — do not improvise with an unrelated tool.")
    lines = [f"{c.name} — {c.summary}" + ("  [irreversible: needs approval]" if c.irreversible else "")
             for c in matches]
    return "\n".join(lines) + "\n\nUse load_tools([...]) to make these callable."


def load_tools(names: list[str]) -> str:
    """Load the full schemas for named tools so you can call them.

    Load only what you need for the immediate next step. There is a hard cap.
    """
    return session_tools.load(names, current_step)
```

The loop then rebuilds the tool list each turn from `session_tools.schemas()` instead of passing
a static list.

## 7. Configuration knobs

| Knob | Default | Effect | Change it when |
|---|---|---|---|
| Tier-1 size | ≤ 6 | Baseline context cost | Promote a tool here when traces show it loaded in > 50% of runs |
| `max_loaded_tools` | 12 | Peak context cost | Lower if runs still bloat; raise only with evidence |
| Summary length | ≤ 120 chars | Discovery quality vs cost | Long enough to choose from, short enough to list 20 |
| Summaries per call | 20 | Result size | Below 10 the agent has to paginate; above 30 it is a flat list again |
| Eviction | 15 unused steps | Long-run bloat | Disable for short runs |
| Index type | domain lookup | Discovery accuracy | Embedding search when domains overlap or needs are fuzzy |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Agent never discovers, just fails | Discovery tools not described as the recovery path | Runs ending without a `list_capabilities` call | Say so explicitly in the system prompt and in every "no tool for this" error |
| Agent loads everything immediately | No cap, or the cap is not explained | Loaded count per run | Hard cap server-side; explain the cap in the load result |
| Summaries too vague to choose from | Written as categories, not capabilities | Read 20 summaries cold | "Find invoices by customer, date, status", not "invoice operations" |
| Context bloats anyway on long runs | No eviction | Token growth per step | LRU eviction of unused tier-3 tools |
| Agent invents tool names | Guessing instead of discovering | Unknown-name errors | Error text must name `list_capabilities` as the fix |
| Extra latency per task | A discovery round-trip on every run | Steps per task vs baseline | Promote frequently-loaded tools to tier 1 |
| Wrong domain chosen repeatedly | Overlapping taxonomy | Domain-selection confusion matrix | Sharpen domains; add semantic `need` search |
| Worse than a flat list | Applied under 15 tools | A/B against a flat list | Revert; this pattern earns its cost only at breadth |

## 9. Anti-patterns

- **Using this instead of fixing tool design.** Forty endpoint-shaped tools discovered lazily are
  still forty badly-shaped tools. Collapse them into task-shaped ones first.
- **Tier-1 creep.** It starts at four tools and ends at eighteen. Promote only on trace evidence,
  and demote as well.
- **Summaries that are categories.** "Billing operations" tells the agent nothing.
- **No cap on `load_tools`.** The agent will load everything and you are back where you started.
- **Not tracing discovery.** The load/use ratio is the data that tells you what to promote.
- **Hiding irreversibility until load time.** Surface it in the summary so the agent can plan
  around approval gates.
- **Applying it below 15 tools.** Extra machinery, extra latency, no benefit.

## 10. Metrics and SLOs

| Metric | Definition | Target | Alert at |
|---|---|---|---|
| Resident schema tokens | Tier-1 cost per turn | < 800 | > 1 500 |
| Peak loaded tools | Max tier-3 per run | ≤ cap | at cap frequently |
| Discovery calls per run | `list_capabilities` count | 0–2 | > 4 |
| Load/use ratio | Tools used / tools loaded | > 0.7 | < 0.4 (loading speculatively) |
| Selection accuracy | Correct tool after discovery | ≥ 95% | < 90% |
| Added latency | vs flat list | < 1 extra step p50 | > 2 |
| Unknown-name errors | Guessed tool names | < 2% | > 10% |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | ≤ 15 tools | Flat list. Correct answer for most agents. |
| v1 | Selection errors appear | Fix tool design first — collapse endpoints into tasks |
| v2 | Still > 15 after collapsing | [Routing](routing.md) to per-family agents |
| v3 | One agent genuinely needs breadth | Two tiers: resident core + `list_capabilities` |
| v4 | Discovery is imprecise | Embedding search over capability summaries |
| v5 | Long runs bloat | LRU eviction + trace-driven tier-1 promotion |

## 12. Build checklist

- [ ] Tool design was fixed first: tools are task-shaped, not endpoint-shaped.
- [ ] Routing was considered before adding discovery machinery.
- [ ] Tier 1 is ≤ 6 tools and includes the discovery entry point.
- [ ] Every capability summary reads as a capability, not a category.
- [ ] Summaries surface irreversibility.
- [ ] `load_tools` has a hard server-side cap, and the cap is explained in its result.
- [ ] "No tool for this" errors explicitly name `list_capabilities`.
- [ ] The session tool set is per-run and reset between runs.
- [ ] Eviction exists for long runs.
- [ ] Discovery and load events are traced; load/use ratio is monitored.
- [ ] Measured against a flat-list baseline on the same eval set.

## 13. Related

- [tool-design.md](tool-design.md) — fix this first; it removes most of the need
- [routing.md](routing.md) — the other way to cut tool count
- [context-engineering.md](context-engineering.md) — the budget this protects
- [agent-loop.md](agent-loop.md) — where the session tool set is assembled
- [mcp-tool-design.md](mcp-tool-design.md) — the same pressure across servers
