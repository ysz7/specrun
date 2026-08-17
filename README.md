<p align="center">
  <img src="https://raw.githubusercontent.com/ysz7/specrun/main/design/media/banner.png" alt="Specrun - AI Coding Agents Tool" width="100%">
</p>

**Blueprints and skills for the AI you already code with.**

A **blueprint** records how a project builds a particular kind of thing — the shape, the contracts, the failure modes, and why each choice was made. Specrun installs a small set of them into your project, together with a router skill whose job is to notice when one of them applies.

You keep working in chat as before. When the task matches a blueprint, your agent reads it first and builds along lines you have already settled instead of designing them again.

It also brings skills that stand on their own: two that run the mechanism (one writes a new blueprint from work you just finished, one draws the project architecture as a single HTML file) and eight that do a job on request — from building an agent loop to auditing one for injection risk.

Everything is plain Markdown in your repository. Nothing calls a model except your agent, in your chat, on your account.

![An architecture map drawn by the map skill](https://raw.githubusercontent.com/ysz7/specrun/main/design/media/map-example.png)

*The `map` skill on another project: blocks named after the jobs the system does, not after its directories. One self-contained HTML file, no network.*

---

## Install

There are two independent channels. The marketplace works with no CLI at all.

**Claude Code plugin** (blueprints and skills only):

```
/plugin marketplace add ysz7/specrun
/plugin install specrun@specrun
```

**CLI** (same content + project installation, lock file, and `specrun scan`):

```
uv tool install specrun
cd your-project
specrun init
```

`init` writes the router and the blueprints into `.claude/skills/`, records what it wrote in `.specrun/lock.json`, and adds the generated map to your `.gitignore`. Commit the rest: what your agent reads is worth reviewing, and a teammate who clones the repository gets the same answers without installing anything.

Install **one or the other**. With both, the same skills arrive twice under slightly different names and compete for the same requests.

### Updating

Plugin (from inside Claude Code):

```
/plugin marketplace update specrun
/plugin update specrun@specrun
```

CLI:

```
uv tool upgrade specrun
cd your-project
specrun sync
```

`sync` rewrites the blueprints and skills it installed and leaves every file you have edited by hand exactly as it is (it lists them at the end). Your own blueprints in `.specrun/local/` are never touched. Without `sync`, a project keeps the content it was given. Use `specrun status` to see if a newer set is available.

---

## What you get

### Skills that run the mechanism

| Skill | Purpose |
|-------|---------|
| [`blueprints`](plugins/specrun/skills/blueprints/SKILL.md) | The router: reads the task, picks a blueprint or says there is none |
| [`blueprint-author`](plugins/specrun/skills/blueprint-author/SKILL.md) | Writes a new blueprint, or your project's own version of a bundled one |
| [`map`](plugins/specrun/skills/map/SKILL.md) | Draws the architecture as one self-contained HTML file |

### Skills that do a job on request

Call them in chat by describing the task, or directly as `/name` (plugin namespace: `/specrun:name`).

| Skill | When to use |
|-------|-------------|
| [`build-agent-loop`](plugins/specrun/skills/build-agent-loop/SKILL.md) | Building an agent from scratch: tool dispatch, step budgets, traces |
| [`design-agent-tools`](plugins/specrun/skills/design-agent-tools/SKILL.md) | The agent picks the wrong tool, passes bad arguments, or drowns in tool output |
| [`write-system-prompt`](plugins/specrun/skills/write-system-prompt/SKILL.md) | Writing or reworking a production system prompt |
| [`build-rag-pipeline`](plugins/specrun/skills/build-rag-pipeline/SKILL.md) | Setting up retrieval over your own documents |
| [`diagnose-rag-failure`](plugins/specrun/skills/diagnose-rag-failure/SKILL.md) | A RAG answer is wrong and it is unclear which stage failed |
| [`build-eval-set`](plugins/specrun/skills/build-eval-set/SKILL.md) | A labelled eval set and scorers, so a change can be shown to have helped |
| [`write-agent-tests`](plugins/specrun/skills/write-agent-tests/SKILL.md) | Tests for an agent: mocked tools, trajectories, adversarial cases |
| [`audit-agent-security`](plugins/specrun/skills/audit-agent-security/SKILL.md) | Reviewing an agent for injection reaching real actions, over-scoped credentials, ungated tools |

### Blueprints

Fifty-two of them ship today. You never pick one from this list in normal use — the router does it when the task matches. The list is here so you know what your agent has available.

**Agent core**

| Blueprint | When it applies |
|-----------|-----------------|
| [Agent loop](plugins/specrun/skills/blueprints/blueprints/agent-loop.md) | Building the loop that calls a model, runs the tools it asks for and repeats until it stops; or an agent runs away, loops, or will not stop on its own |
| [Context engineering](plugins/specrun/skills/blueprints/blueprints/context-engineering.md) | Deciding what occupies the model's context on a long run: the agent forgets what was said early on, quality falls off as the run grows, or cost is dominated by re-sending history |
| [Framework selection](plugins/specrun/skills/blueprints/blueprints/framework-selection.md) | Choosing what an agent runs on — a plain loop, a graph framework, a provider SDK or a managed platform — at the start of a project, or revisiting that choice |
| [Human in the loop](plugins/specrun/skills/blueprints/blueprints/human-in-the-loop.md) | An agent can spend money, message people, delete data or write to production, and some actions need an approval gate, a sandbox or a dry run before they execute |
| [Memory architecture](plugins/specrun/skills/blueprints/blueprints/memory-architecture.md) | The agent has to remember across sessions: facts learned in one run applying to the next, user preferences that persist, or any store of knowledge outside the context window |
| [Progressive tool discovery](plugins/specrun/skills/blueprints/blueprints/progressive-tool-discovery.md) | The agent has more than about fifteen tools, tool schemas dominate the prompt, or accuracy drops with every tool added |
| [Skill engineering](plugins/specrun/skills/blueprints/blueprints/skill-engineering.md) | Writing the markdown procedures an agent loads on demand — skills, playbooks, the instructions that keep being pasted into chat by hand |
| [State machine and reducer](plugins/specrun/skills/blueprints/blueprints/state-machine-reducer.md) | State changes have to be deterministic and auditable while the model only decides; the agent loses the thread because its state lives in the conversation |
| [Tool design](plugins/specrun/skills/blueprints/blueprints/tool-design.md) | An agent has more than one tool and picks the wrong one, sends malformed arguments, or misreads what a tool returned; tool schemas, descriptions and return shapes are being written or reworked |

**Agent workflows**

| Blueprint | When it applies |
|-----------|-----------------|
| [Evaluator and optimizer](plugins/specrun/skills/blueprints/blueprints/evaluator-optimizer.md) | First drafts are reliably mediocre and the quality criteria can be stated, so a critic scores each attempt and the generator revises until it clears a bar |
| [Orchestrator and workers](plugins/specrun/skills/blueprints/blueprints/orchestrator-workers.md) | A lead model has to split a task into subtasks at runtime and dispatch them to workers with their own context windows; multi-agent, search-heavy work |
| [Parallelization](plugins/specrun/skills/blueprints/blueprints/parallelization.md) | Running model calls concurrently — independent sections merged at the end, or the same task sampled several times and voted on to raise reliability |
| [Prompt chaining](plugins/specrun/skills/blueprints/blueprints/prompt-chaining.md) | The steps are known in advance and always the same, and each one can be checked before the next runs — a fixed pipeline of model calls rather than an agent |
| [Routing](plugins/specrun/skills/blueprints/blueprints/routing.md) | Inputs fall into distinct families needing different prompts, models or tools, and one prompt for all of them degrades every case; classifying an input before handling it |

**Retrieval**

| Blueprint | When it applies |
|-----------|-----------------|
| [Agentic RAG](plugins/specrun/skills/blueprints/blueprints/agentic-rag.md) | One retrieval pass is not enough: the agent has to search, judge what came back and search again, across several sources or several steps |
| [Chunking strategies](plugins/specrun/skills/blueprints/blueprints/chunking-strategies.md) | Deciding how documents are split before indexing; retrieved chunks are truncated, mix several topics, or lose the structure of the source |
| [Contextual retrieval](plugins/specrun/skills/blueprints/blueprints/contextual-retrieval.md) | Retrieved chunks are relevant but unusable on their own — pronouns without antecedents, numbers without units, sections without a subject |
| [GraphRAG](plugins/specrun/skills/blueprints/blueprints/graph-rag.md) | Questions are about relationships between entities, or need aggregating across the whole corpus, which independent chunk retrieval structurally cannot answer |
| [Hybrid search with RRF](plugins/specrun/skills/blueprints/blueprints/hybrid-search-rrf.md) | Search misses exact strings — error codes, SKUs, function names, proper nouns — or recall is short with embeddings alone, so lexical and dense results have to be fused |
| [Query transformation](plugins/specrun/skills/blueprints/blueprints/query-transformation.md) | Questions are conversational, vague or multi-part, or worded nothing like the corpus, so the query has to be rewritten, expanded or decomposed before it reaches the index |
| [RAG baseline](plugins/specrun/skills/blueprints/blueprints/rag-baseline.md) | Answers have to come from a document corpus the model was not trained on, the corpus changes, or answers must cite their sources; retrieval is being set up, or the model hallucinates and cannot attribute what it says |
| [RAG evaluation](plugins/specrun/skills/blueprints/blueprints/rag-evaluation.md) | Measuring a RAG system so a regression points at retrieval or at generation, instead of tuning chunk size, k and the prompt by feel |
| [Reranking](plugins/specrun/skills/blueprints/blueprints/reranking.md) | The right chunk is retrieved but ranked far down: recall is high and precision in the top few is low, or k must be cut before the prompt without losing the answer |
| [Vector store selection](plugins/specrun/skills/blueprints/blueprints/vector-store-selection.md) | Choosing where embeddings live and which index and metadata filtering they use; or the store's recall, p95 latency or cost has become the constraint |

**Prompting**

| Blueprint | When it applies |
|-----------|-----------------|
| [Few-shot examples and reasoning](plugins/specrun/skills/blueprints/blueprints/few-shot-and-reasoning.md) | Output format is inconsistent, or the task needs multi-step derivation, and it is unclear whether to add examples or a reasoning scaffold |
| [Guardrails and injection defence](plugins/specrun/skills/blueprints/blueprints/guardrails-and-injection-defense.md) | The system reads content it did not author — user text, web pages, email, uploaded files, third-party tool results — and a model follows instructions hidden inside it |
| [Prompt caching](plugins/specrun/skills/blueprints/blueprints/prompt-caching.md) | The same prefix goes out on every call and should be billed once; or caching is configured and the hit rate is near zero |
| [Prompt structure](plugins/specrun/skills/blueprints/blueprints/prompt-structure.md) | Writing or reworking a production prompt: what belongs in the system block, in what order, how the sections are delimited, and which parts have to stay byte-stable |
| [Structured output](plugins/specrun/skills/blueprints/blueprints/structured-output.md) | The model's output feeds code and has to parse every time: JSON that keeps failing, schema-constrained decoding, tool-call schemas, validation and repair |

**Evaluation**

| Blueprint | When it applies |
|-----------|-----------------|
| [Agent trajectory evaluation](plugins/specrun/skills/blueprints/blueprints/agent-trajectory-eval.md) | Grading the path a multi-step agent took — which tools it chose, in what order, how it recovered from errors and what it cost — not only its final answer |
| [Eval harness design](plugins/specrun/skills/blueprints/blueprints/eval-harness-design.md) | Turning 'this seems better' into a number: the dataset, the scorers and the runner, before the second change to any LLM system |
| [LLM as judge](plugins/specrun/skills/blueprints/blueprints/llm-as-judge.md) | Quality is genuinely subjective and no deterministic check exists, so a model scores the output; or the judge's scores disagree with human raters |
| [Regression and CI evals](plugins/specrun/skills/blueprints/blueprints/regression-and-ci-evals.md) | Wiring evals into the development loop so a quality regression blocks a merge instead of reaching users |
| [Simulated users](plugins/specrun/skills/blueprints/blueprints/simulated-users.md) | Evaluating a multi-turn or conversational agent, or offline scores look good while production behaviour does not match them |

**Data pipelines**

| Blueprint | When it applies |
|---|---|
| [Data quality and PII](plugins/specrun/skills/blueprints/blueprints/data-quality-and-pii.md) | Validating what enters the index, and detecting, redacting or gating personal data before it is irreversibly embedded, logged and retrievable |
| [Document parsing](plugins/specrun/skills/blueprints/blueprints/document-parsing.md) | Inputs are PDFs, Office files, HTML or scans and have to become clean text that keeps headings, tables, reading order and page provenance |
| [Embedding pipeline](plugins/specrun/skills/blueprints/blueprints/embedding-pipeline.md) | Embedding text at scale: batching, rate limits, caching, retries, and the migration path for the day the embedding model changes |
| [Incremental sync and CDC](plugins/specrun/skills/blueprints/blueprints/incremental-sync-cdc.md) | Keeping a derived index current by processing only what changed; a full re-run is too slow or too costly, or the index has drifted from its source |
| [Ingestion pipeline](plugins/specrun/skills/blueprints/blueprints/ingestion-pipeline.md) | Documents or records have to be loaded continuously into an index or store, with idempotency, incremental runs, and one bad document not stopping the batch |

**Agent protocols**

| Blueprint | When it applies |
|---|---|
| [Agent-to-agent (A2A)](plugins/specrun/skills/blueprints/blueprints/a2a-agent-to-agent.md) | Handing an outcome to an autonomous agent you do not own — another team's or another company's — by specifying the goal rather than the call |
| [AG-UI frontend streaming](plugins/specrun/skills/blueprints/blueprints/ag-ui-frontend-streaming.md) | The interface has to show what the agent is doing while it works: tokens, tool calls, thinking traces, interruptions |
| [Agent protocols overview](plugins/specrun/skills/blueprints/blueprints/agent-protocols-overview.md) | Choosing which wire protocol fits — tools, agent-to-agent delegation, frontend streaming — when an agent has to talk to something outside its own process |

**LLM infrastructure**

| Blueprint | When it applies |
|---|---|
| [Cost and rate limits](plugins/specrun/skills/blueprints/blueprints/cost-and-rate-limits.md) | Token spend is unpredictable or unattributable, the bill grows faster than usage, or provider 429s are reaching users |
| [LLM gateway](plugins/specrun/skills/blueprints/blueprints/gateway-and-routing.md) | More than one service or provider is being called, and keys, retries, fallbacks, caching, quotas and cost attribution should sit in one place in front of them |
| [Observability and tracing](plugins/specrun/skills/blueprints/blueprints/observability-tracing.md) | A production run cannot be reconstructed: no traces of LLM calls and agent steps with inputs, outputs, tokens, cost and outcome, and a user's complaint cannot be reproduced |
| [Security and secrets](plugins/specrun/skills/blueprints/blueprints/security-and-secrets.md) | Credential scoping, storage and rotation for a system where a model can call tools, read external content, or serve more than one tenant |
| [Small models and distillation](plugins/specrun/skills/blueprints/blueprints/small-models-and-distillation.md) | One task type dominates the token bill or the latency budget and should move to a smaller model, a fine-tune or a distilled student |

**MCP servers**

| Blueprint | When it applies |
|---|---|
| [MCP authorization](plugins/specrun/skills/blueprints/blueprints/mcp-authorization.md) | A remote or multi-user MCP server has to establish who is calling and what they may do: OAuth 2.1, issuer validation, and scoping that survives prompt injection |
| [MCP protocol overview](plugins/specrun/skills/blueprints/blueprints/mcp-protocol-overview.md) | A capability has to be reachable from more than one AI application or owned by another team, and MCP is the candidate; understanding the protocol before building on it |
| [MCP server design](plugins/specrun/skills/blueprints/blueprints/mcp-server-design.md) | Building an MCP server someone else will use: what it exposes, which primitive each capability should be, state and errors across a stateless boundary, versioning |
| [MCP tool design](plugins/specrun/skills/blueprints/blueprints/mcp-tool-design.md) | Designing the tool surface of an MCP server for consumers you will never meet, running models you did not choose, in contexts you cannot see |
| [MCP transports](plugins/specrun/skills/blueprints/blueprints/mcp-transports.md) | Deciding between stdio and Streamable HTTP for shipping a server, or migrating one written before the 2026-07-28 revision |

These are the starting set, not the point — the point is the mechanism, and much of the value
shows up in the blueprints you write for your own project.

---

## Commands

```
specrun init       install the blueprints and skills into this project
specrun sync       regenerate them, keeping anything you edited by hand
specrun status     what is installed, what is stale, what you have edited
specrun scan       read facts about this repository (--json feeds the map skill)
specrun --version
```

`--cwd PATH` acts on another directory, `--json` prints machine-readable output, `--quiet` prints
only what needs attention. `init` and `sync` take `--force` to overwrite files you have edited.

---

## Who owns which file

Specrun writes into `.claude/skills/` and records the hash of every file it wrote. Before writing
again it compares: if a file still matches its recorded hash it is regenerated, and if it does not
— you edited it — it is left exactly as it is and reported. `--force` overrides that, and nothing
else does.

`.specrun/local/` is yours and is never written to. Upgrading the package does not touch it.

```
.claude/skills/          generated; yours the moment you edit one
.specrun/local/          yours; blueprints you wrote
.specrun/lock.json       what Specrun wrote, and the hash it wrote
.specrun/map.html        a generated report, gitignored
```

`specrun status` says when the package carries content newer than what is installed — the signal
to run `specrun sync`, as above.

---

## Your own blueprints

Put a markdown file in `.specrun/local/blueprints/` and run `specrun sync`. That is the whole
mechanism — it will be in the router's table, and your agent will choose it exactly as it chooses
a bundled one.

```markdown
+++
id = "background-jobs"
title = "Background jobs"
use_when = "adding or changing a background job, a worker, or a scheduled task"
+++

# Background jobs

Everything queued goes through one queue and one worker pool. Retries are the queue's job,
not the handler's...
```

Three fields in the header, and the fence is `+++` because the header is TOML. Below it, write
whatever your project needs to say.

**`use_when` is the line that matters.** It is what your agent reads when deciding whether this
blueprint fits the task in hand; the title and the body are only read after it has decided. Write
it the way a developer would describe the task in chat — "the search results are wrong and I am
reworking retrieval" — rather than the way the pattern is named. A blueprint nobody's phrasing
ever matches is a file that is never opened.

**Your blueprints join one shared choice.** The agent picks from all of them at once, yours and
the bundled ones together, so a vague `use_when` — "improvements", "best practices", "when working
on this project" — does not merely fail to attract its own blueprint. It makes the neighbouring
rows harder to tell apart, and the agent starts picking the wrong one for tasks that used to work.
Before adding a blueprint, run `specrun status` and read your new line against the ones already
there. If you cannot tell two of them apart at a glance, neither can the agent.

`specrun status` is also where you find out whether a file was picked up at all: a blueprint with
a broken header is reported by name and reason, and everything else carries on working.

A local blueprint whose `id` matches a bundled one replaces it. That is deliberate — it is how a
project says it has decided otherwise — and `status` marks the line so nobody has to guess why the
original stopped being followed. The `blueprint-author` skill writes these for you: ask it in chat
to write your own version of a blueprint, and it records what differs and why.

**Reference — all header fields:**

| Field | |
|---|---|
| `id` | required; also the file name of the installed copy |
| `title` | required; shown in the router's table |
| `use_when` | required; what the agent matches the task against |
| `pack` | optional; which family of blueprints this belongs to |
| `verified_at` | optional; a date, e.g. `2026-08-12` |
| `stale_after` | optional; `90d`, `12w`, `6m`, `1y` — counted from `verified_at` |
| `verified_against` | optional; a table of versions, e.g. `{ "anthropic-sdk" = "0.40.x" }` |
| `based_on` | optional; the bundled blueprint this one was written against |

A blueprint that says nothing about freshness never goes stale: silence means no promise was made,
not that a promise ran out. Fill in `verified_at` and `stale_after` when you want to be reminded
to re-check it, and leave them out otherwise.

---

## Your own skills

Ordinary Claude Code skills go in `.claude/skills/<name>/SKILL.md` and work immediately. Specrun
is not involved, and there is nothing to register or sync — it only owns the folders listed in
`.specrun/lock.json`.

See the [Claude Code skills documentation](https://code.claude.com/docs/en/skills) for the format.

---

## The map

Ask for it in chat — "draw the architecture of this repo" — or call the skill directly with
`/specrun:map`. It runs `specrun scan --json` for the facts, reads enough of the code to say what
each part is *for*, and writes `.specrun/map.html`: one file, no network, opens on a double click.

The map is named after the jobs the system does, not after its directories, and it is capped at
nine blocks across the top level. A picture of thirty boxes is a picture nobody reads.

`specrun scan` on its own prints the same facts as text — the tree with file counts, modules and
the imports between them, entry points, dependencies and infrastructure — which is worth a look
before you ask for a map, since it is everything the map is built from.

---

## Requirements

Python 3.11 or newer, and no dependencies beyond the standard library. Claude Code is the agent
supported today; the emitter that writes the skill files is deliberately the only part that knows
that, so other targets are a matter of adding one.

---

## Licence

MIT © 2026 Denys Zhodik.

The map's rendering approach is based on
[`Cocoon-AI/architecture-diagram-generator`](https://github.com/Cocoon-AI/architecture-diagram-generator)
by Cocoon AI, MIT — see `plugins/specrun/skills/map/THIRD_PARTY_LICENSES`. The visual design is
this project's own.
