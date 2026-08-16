+++
id = "framework-selection"
title = "Framework selection"
use_when = "Choosing what an agent runs on — a plain loop, a graph framework, a provider SDK or a managed platform — at the start of a project, or revisiting that choice"
pack = "agent core"
verified_at = 2026-08-12
stale_after = "90d"
+++

# Framework and Stack Selection

<!-- verified: 2026-08-12 -->

> Choosing what the agent runs on — a plain loop, a graph framework, a provider SDK, or a
> combination — and making that choice explicit and reversible instead of accidental.

**Tier:** foundational
**Use when:** starting any agent. The choice is made on day one either deliberately or by
whatever the first tutorial used.
**Avoid when:** never — but note that "no framework" is a valid and often correct answer.
**Cost profile:** free to decide, expensive to reverse once the whole codebase assumes one.

---

## 1. Problem it solves

There are well over a hundred agent frameworks. Teams pick one from a blog post, build six weeks
of code around its abstractions, then discover it does not do the one thing they need — usually
durable state, human-in-the-loop interrupts, or observability into what actually happened.

The second failure is the opposite: adopting a heavy orchestration framework for a task that is
one LLM call and two tools, and spending more time fighting the abstraction than the problem
would have taken.

The practice that has settled in 2026 is **combination, not selection**: one tool for the part
it is genuinely good at, glued with ordinary code. "Framework for research → framework for
execution" is now a normal architecture, not a compromise.

## 2. Shape — the decision, in order

```
  Can you write the sequence of steps before seeing the input?
  ├── YES ──▶ It is not an agent. Plain code + N LLM calls.
  │           prompt-chaining.md
  │
  └── NO ──▶ Does the workflow have NAMED STATES a business person would recognise?
             (submitted → gathering → deciding → awaiting_review → executing)
             ├── YES ──▶ GRAPH framework (LangGraph-class)
             │           you get: durable state, interrupts, resumability, replay
             │           you pay: an abstraction to learn, and to live inside
             │
             └── NO ──▶ How many tools?
                        ├── ≤ 15 ──▶ PLAIN LOOP + provider SDK
                        │            you get: full control, trivial debugging
                        │            you pay: writing budgets/retries/tracing yourself
                        │
                        └── > 15 ──▶ split first (routing / sub-agents),
                                     THEN re-ask this question per split
```

**Default answer when unsure: plain loop.** You can always add a graph later around code you
understand. Extracting your logic out of someone else's abstraction is much harder.

## 3. Components — what each option actually gives you

| Option | You get | You pay | Pick it when |
|---|---|---|---|
| **Plain loop + provider SDK** | Total control; every failure is in your code; trivial to debug and test | You write budgets, retries, tracing, persistence yourself (~300 lines, all in this library) | ≤ 15 tools, no named states, team is comfortable owning it |
| **Graph framework** (LangGraph-class) | Durable state, interrupts/resume, checkpointing, replay, deterministic control flow | An abstraction you now live inside; debugging goes through its model | Named states; human-in-the-loop mid-workflow; compliance needs replay |
| **Role/crew framework** (CrewAI-class) | Fastest demo — multi-agent in days | Needs substantial rework for production reliability | Prototypes, internal research tools, proving a concept |
| **Conversation framework** (AutoGen-class) | Async multi-agent conversation at scale | Open-ended agent debate makes token spend hard to predict | Multi-agent conversation is genuinely the shape of the problem |
| **Provider Agents SDK** | Lowest friction on that provider; tool use and streaming handled | Vendor coupling in your core loop | Already committed to that provider; want their loop semantics |
| **Multimodal-native SDK** (Google ADK-class) | Native image/video/document handling | Smaller ecosystem | The task is genuinely multimodal |
| **RAG-oriented workflows** (LlamaIndex-class) | Retrieval pipelines as first-class objects | Less suited to general action-taking | Retrieval is the product, actions are secondary |
| **Durable workflow engine** (Temporal-class) | Real durability: survives process death, deterministic replay, retries | Operational weight; a different mental model | Runs last hours/days; money or compliance is involved |

**These are categories, not endorsements.** Names change; the categories have been stable.
Verify current options before committing — see §6.

## 4. Data flow — how to actually decide

1. Write the **states** of your workflow on paper. If you can name them, you want a graph.
2. Count the **tools**. Above 15, split before choosing anything.
3. Ask **how long a run lives**. Seconds → any option. Hours or days → durable engine.
4. Ask **who must intervene mid-run**. If a human approves *inside* the workflow and it must
   survive a deploy, you need durable interrupts, not a `while` loop.
5. Ask **what must be replayable**. Compliance replay is a hard requirement that eliminates most
   options.
6. Only now look at frameworks — and check the current state of each, because this list ages
   in months.

## 5. Contracts — keep the choice reversible

Whatever you pick, keep your own types at the boundary. This is what makes a framework swap a
week rather than a rewrite.

```python
from pydantic import BaseModel
from typing import Protocol, Any

class AgentRequest(BaseModel):
    task: str
    context: dict[str, Any] = {}
    budget_usd: float = 1.0
    max_steps: int = 20

class AgentResult(BaseModel):
    output: str
    steps: int
    cost_usd: float
    trace_id: str
    status: str

class AgentRuntime(Protocol):
    """Your code depends on THIS, not on the framework.
    Swapping the framework means writing one new implementation."""
    async def run(self, req: AgentRequest) -> AgentResult: ...

# Tools stay yours too — plain functions plus JSON Schema, adapted per framework.
# Do NOT let a framework's tool decorator become the only definition of your tools.
```

Anything the framework touches lives behind this interface. Business logic, tool implementations,
and prompts stay in plain modules that know nothing about it.

## 6. Reference implementation — the proposal an AI should make

When an AI is handed an agent blueprint, it should not ask an open question. It should propose,
with reasoning, and ask for confirmation:

```markdown
## Proposed stack

**Runtime: plain agent loop + <provider> SDK**
Why: the workflow has no named states a business owner would recognise, there are 6 tools,
and no human intervenes mid-run. A graph framework would add an abstraction without
buying durability we need.

**Persistence: Postgres row per run**
Why: runs last under 2 minutes; a durable workflow engine is not justified.

**Verified today (2026-08-12):**
- <provider> SDK <version> — current tool-use API confirmed
- model <id> — context limit and pricing confirmed
- MCP spec 2026-07-28 — stateless, affects the two MCP tools

**What would change this decision:**
- If approvals must happen mid-workflow and survive a deploy → graph framework with checkpointing
- If tool count passes 15 → split by routing first, then re-decide

Confirm, or tell me which constraint I got wrong.
```

That is the whole interaction. One proposal, one reasoned justification, one question.

## 7. Configuration knobs

| Knob | Default | Change it when |
|---|---|---|
| Framework | none (plain loop) | You can name the workflow's states |
| Boundary interface | always | Non-negotiable — it is what keeps the choice reversible |
| Persistence | DB row per run | Durable engine when runs outlive a process |
| Tool definitions | plain functions + schema | Never framework-native only |
| Prompt storage | files in the repo | Never inside framework config |
| Observability | OTel spans you emit | Do not depend solely on a framework's proprietary tracing |
| Combination | allowed | Common and correct — one tool per part |

## 8. Failure modes

| Symptom | Root cause | Detection | Mitigation |
|---|---|---|---|
| Cannot explain why the agent did X | Control flow lives inside the framework | Try to trace one run by reading code | Emit your own spans; prefer explicit graphs over implicit magic |
| Six weeks in, the framework cannot do the one thing you need | Chose before listing hard requirements | Requirements written after the choice | List durability, interrupts, replay needs *first* |
| Framework swap means a rewrite | No boundary interface | Framework types appear throughout the codebase | `AgentRuntime` protocol; framework confined to one module |
| Token spend unpredictable | Open-ended multi-agent conversation | Cost variance per run | Hard caps; bound the conversation; consider a different shape |
| Heavy framework for a two-step task | Cargo-culted from a tutorial | Read the code — is most of it framework glue? | Delete it; a plain loop is ~300 lines |
| Upgrade broke everything | Framework major version | Pinned versions absent | Pin; read migration notes; keep the boundary thin |
| Prompts unversioned | Stored in framework config | `git log` on prompts is empty | Prompts are files in the repo |

## 9. Anti-patterns

- **Choosing before listing hard requirements.** Durability, mid-run interrupts, replay, and
  audit are the requirements that eliminate options. Everything else is taste.
- **Framework types throughout the codebase.** Confine it to one module behind your own interface.
- **A graph framework for a linear task.** If you can write the steps down, write them down.
- **A plain loop for a workflow that must survive a deploy mid-approval.** That is what
  checkpointing exists for.
- **Believing a framework's tracing is enough.** Emit your own spans; you will need them when you
  swap or when the vendor's UI does not answer your question.
- **Picking by GitHub stars.** Popularity is not durability, and this field's popularity moves
  quarterly.
- **Never revisiting.** Re-ask this question when tool count, run duration, or intervention
  requirements change.

## 10. Metrics and SLOs

| Metric | Definition | Target |
|---|---|---|
| Framework-coupled files | Files importing the framework | ≤ 2 |
| Time to swap runtime (estimated) | Honest estimate by the team | ≤ 1 week |
| Glue-code ratio | Framework plumbing / business logic | < 0.3 |
| Run reconstructability | Runs fully explainable from your own traces | 100% |
| Time to debug a failed run | From report to root cause | < 30 min |

## 11. Scaling path

| Stage | Trigger | What changes |
|---|---|---|
| v0 | — | Plain loop, provider SDK, your own budgets and traces |
| v1 | Named states appear | Explicit state machine in your code ([state-machine-reducer.md](state-machine-reducer.md)) |
| v2 | Interrupts must survive restarts | Graph framework with checkpointing, behind your interface |
| v3 | Runs last hours or days | Durable workflow engine for the outer loop, agent loop inside |
| v4 | Distinct task families | Different runtimes per family — combination is normal |

## 12. Build checklist

- [ ] Hard requirements written down **before** any framework was named: durability, mid-run
      interrupts, replay, audit, run duration.
- [ ] The workflow's states were listed on paper (or explicitly found not to exist).
- [ ] Tool count is under 15, or the split was done first.
- [ ] An `AgentRuntime`-style boundary interface exists; the framework is confined behind it.
- [ ] Tool implementations are plain functions, usable without the framework.
- [ ] Prompts are files in the repo, not framework configuration.
- [ ] Your own OTel spans are emitted regardless of framework tracing.
- [ ] Framework versions are pinned.
- [ ] The chosen stack and its justification are written in the project README.
- [ ] Current framework and SDK options were verified on the web, not recalled.

## 13. Related

- [agent-loop.md](agent-loop.md) — what a plain loop actually contains
- [state-machine-reducer.md](state-machine-reducer.md) — named states without a framework
- [tool-design.md](tool-design.md) — the tool-count constraint driving the split
- [routing.md](routing.md) — how to split when there are too many tools
- [observability-tracing.md](observability-tracing.md) — traces you own
