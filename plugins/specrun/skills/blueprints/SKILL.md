---
name: blueprints
description: Architectural blueprints this project has already settled on, covering agent core, agent protocols, agent workflows, data pipelines, evaluation, LLM infrastructure, MCP servers, prompting and retrieval. Use when building, extending or fixing a feature in one of those areas, so the work follows the recorded approach and its reasoning instead of being designed again from scratch. Not for topics with no blueprint here, and not for ordinary coding questions.
---

# Blueprints

A blueprint records how this project builds a particular kind of thing: the shape, the
contracts, the failure modes, and why each choice was made. Following one keeps a new
feature consistent with what is already here — which usually matters more than whether
any single decision inside it was the best available.

## Choosing one

Match the task against the *when it applies* column below, then read that file in full.

If nothing matches, there is no blueprint for this work. Say so and carry on normally: a
blueprint stretched over a task it was not written for imports decisions that were made
for a different problem, which is worse than having no blueprint at all.

| Blueprint | When it applies |
|---|---|
| [Agent-to-agent (A2A)](blueprints/a2a-agent-to-agent.md) | Handing an outcome to an autonomous agent you do not own — another team's or another company's — by specifying the goal rather than the call |
| [AG-UI frontend streaming](blueprints/ag-ui-frontend-streaming.md) | The interface has to show what the agent is doing while it works: tokens, tool calls, thinking traces, interruptions |
| [Agent loop](blueprints/agent-loop.md) | Building the loop that calls a model, runs the tools it asks for and repeats until it stops; or an agent runs away, loops, or will not stop on its own |
| [Agent protocols overview](blueprints/agent-protocols-overview.md) | Choosing which wire protocol fits — tools, agent-to-agent delegation, frontend streaming — when an agent has to talk to something outside its own process |
| [Agent trajectory evaluation](blueprints/agent-trajectory-eval.md) | Grading the path a multi-step agent took — which tools it chose, in what order, how it recovered from errors and what it cost — not only its final answer |
| [Agentic RAG](blueprints/agentic-rag.md) | One retrieval pass is not enough: the agent has to search, judge what came back and search again, across several sources or several steps |
| [Chunking strategies](blueprints/chunking-strategies.md) | Deciding how documents are split before indexing; retrieved chunks are truncated, mix several topics, or lose the structure of the source |
| [Context engineering](blueprints/context-engineering.md) | Deciding what occupies the model's context on a long run: the agent forgets what was said early on, quality falls off as the run grows, or cost is dominated by re-sending history |
| [Contextual retrieval](blueprints/contextual-retrieval.md) | Retrieved chunks are relevant but unusable on their own — pronouns without antecedents, numbers without units, sections without a subject |
| [Cost and rate limits](blueprints/cost-and-rate-limits.md) | Token spend is unpredictable or unattributable, the bill grows faster than usage, or provider 429s are reaching users |
| [Data quality and PII](blueprints/data-quality-and-pii.md) | Validating what enters the index, and detecting, redacting or gating personal data before it is irreversibly embedded, logged and retrievable |
| [Document parsing](blueprints/document-parsing.md) | Inputs are PDFs, Office files, HTML or scans and have to become clean text that keeps headings, tables, reading order and page provenance |
| [Embedding pipeline](blueprints/embedding-pipeline.md) | Embedding text at scale: batching, rate limits, caching, retries, and the migration path for the day the embedding model changes |
| [Eval harness design](blueprints/eval-harness-design.md) | Turning 'this seems better' into a number: the dataset, the scorers and the runner, before the second change to any LLM system |
| [Evaluator and optimizer](blueprints/evaluator-optimizer.md) | First drafts are reliably mediocre and the quality criteria can be stated, so a critic scores each attempt and the generator revises until it clears a bar |
| [Few-shot examples and reasoning](blueprints/few-shot-and-reasoning.md) | Output format is inconsistent, or the task needs multi-step derivation, and it is unclear whether to add examples or a reasoning scaffold |
| [Framework selection](blueprints/framework-selection.md) | Choosing what an agent runs on — a plain loop, a graph framework, a provider SDK or a managed platform — at the start of a project, or revisiting that choice |
| [LLM gateway](blueprints/gateway-and-routing.md) | More than one service or provider is being called, and keys, retries, fallbacks, caching, quotas and cost attribution should sit in one place in front of them |
| [GraphRAG](blueprints/graph-rag.md) | Questions are about relationships between entities, or need aggregating across the whole corpus, which independent chunk retrieval structurally cannot answer |
| [Guardrails and injection defence](blueprints/guardrails-and-injection-defense.md) | The system reads content it did not author — user text, web pages, email, uploaded files, third-party tool results — and a model follows instructions hidden inside it |
| [Human in the loop](blueprints/human-in-the-loop.md) | An agent can spend money, message people, delete data or write to production, and some actions need an approval gate, a sandbox or a dry run before they execute |
| [Hybrid search with RRF](blueprints/hybrid-search-rrf.md) | Search misses exact strings — error codes, SKUs, function names, proper nouns — or recall is short with embeddings alone, so lexical and dense results have to be fused |
| [Incremental sync and CDC](blueprints/incremental-sync-cdc.md) | Keeping a derived index current by processing only what changed; a full re-run is too slow or too costly, or the index has drifted from its source |
| [Ingestion pipeline](blueprints/ingestion-pipeline.md) | Documents or records have to be loaded continuously into an index or store, with idempotency, incremental runs, and one bad document not stopping the batch |
| [LLM as judge](blueprints/llm-as-judge.md) | Quality is genuinely subjective and no deterministic check exists, so a model scores the output; or the judge's scores disagree with human raters |
| [MCP authorization](blueprints/mcp-authorization.md) | A remote or multi-user MCP server has to establish who is calling and what they may do: OAuth 2.1, issuer validation, and scoping that survives prompt injection |
| [MCP protocol overview](blueprints/mcp-protocol-overview.md) | A capability has to be reachable from more than one AI application or owned by another team, and MCP is the candidate; understanding the protocol before building on it |
| [MCP server design](blueprints/mcp-server-design.md) | Building an MCP server someone else will use: what it exposes, which primitive each capability should be, state and errors across a stateless boundary, versioning |
| [MCP tool design](blueprints/mcp-tool-design.md) | Designing the tool surface of an MCP server for consumers you will never meet, running models you did not choose, in contexts you cannot see |
| [MCP transports](blueprints/mcp-transports.md) | Deciding between stdio and Streamable HTTP for shipping a server, or migrating one written before the 2026-07-28 revision |
| [Memory architecture](blueprints/memory-architecture.md) | The agent has to remember across sessions: facts learned in one run applying to the next, user preferences that persist, or any store of knowledge outside the context window |
| [Observability and tracing](blueprints/observability-tracing.md) | A production run cannot be reconstructed: no traces of LLM calls and agent steps with inputs, outputs, tokens, cost and outcome, and a user's complaint cannot be reproduced |
| [Orchestrator and workers](blueprints/orchestrator-workers.md) | A lead model has to split a task into subtasks at runtime and dispatch them to workers with their own context windows; multi-agent, search-heavy work |
| [Parallelization](blueprints/parallelization.md) | Running model calls concurrently — independent sections merged at the end, or the same task sampled several times and voted on to raise reliability |
| [Progressive tool discovery](blueprints/progressive-tool-discovery.md) | The agent has more than about fifteen tools, tool schemas dominate the prompt, or accuracy drops with every tool added |
| [Prompt caching](blueprints/prompt-caching.md) | The same prefix goes out on every call and should be billed once; or caching is configured and the hit rate is near zero |
| [Prompt chaining](blueprints/prompt-chaining.md) | The steps are known in advance and always the same, and each one can be checked before the next runs — a fixed pipeline of model calls rather than an agent |
| [Prompt structure](blueprints/prompt-structure.md) | Writing or reworking a production prompt: what belongs in the system block, in what order, how the sections are delimited, and which parts have to stay byte-stable |
| [Query transformation](blueprints/query-transformation.md) | Questions are conversational, vague or multi-part, or worded nothing like the corpus, so the query has to be rewritten, expanded or decomposed before it reaches the index |
| [RAG baseline](blueprints/rag-baseline.md) | Answers have to come from a document corpus the model was not trained on, the corpus changes, or answers must cite their sources; retrieval is being set up, or the model hallucinates and cannot attribute what it says |
| [RAG evaluation](blueprints/rag-evaluation.md) | Measuring a RAG system so a regression points at retrieval or at generation, instead of tuning chunk size, k and the prompt by feel |
| [Regression and CI evals](blueprints/regression-and-ci-evals.md) | Wiring evals into the development loop so a quality regression blocks a merge instead of reaching users |
| [Reranking](blueprints/reranking.md) | The right chunk is retrieved but ranked far down: recall is high and precision in the top few is low, or k must be cut before the prompt without losing the answer |
| [Routing](blueprints/routing.md) | Inputs fall into distinct families needing different prompts, models or tools, and one prompt for all of them degrades every case; classifying an input before handling it |
| [Security and secrets](blueprints/security-and-secrets.md) | Credential scoping, storage and rotation for a system where a model can call tools, read external content, or serve more than one tenant |
| [Simulated users](blueprints/simulated-users.md) | Evaluating a multi-turn or conversational agent, or offline scores look good while production behaviour does not match them |
| [Skill engineering](blueprints/skill-engineering.md) | Writing the markdown procedures an agent loads on demand — skills, playbooks, the instructions that keep being pasted into chat by hand |
| [Small models and distillation](blueprints/small-models-and-distillation.md) | One task type dominates the token bill or the latency budget and should move to a smaller model, a fine-tune or a distilled student |
| [State machine and reducer](blueprints/state-machine-reducer.md) | State changes have to be deterministic and auditable while the model only decides; the agent loses the thread because its state lives in the conversation |
| [Structured output](blueprints/structured-output.md) | The model's output feeds code and has to parse every time: JSON that keeps failing, schema-constrained decoding, tool-call schemas, validation and repair |
| [Tool design](blueprints/tool-design.md) | An agent has more than one tool and picks the wrong one, sends malformed arguments, or misreads what a tool returned; tool schemas, descriptions and return shapes are being written or reworked |
| [Vector store selection](blueprints/vector-store-selection.md) | Choosing where embeddings live and which index and metadata filtering they use; or the store's recall, p95 latency or cost has become the constraint |

## Using one

Read the whole file before writing anything. A blueprint is not a template to copy from:
it says which decisions are settled and why, so the parts that do not fit the task at
hand can be dropped deliberately rather than by accident.

Blueprints record versions they were checked against and go out of date. Where a
blueprint's assumptions no longer hold — a library has moved on, the code already does
something else for a reason — follow the code and say what disagreed, rather than
reshaping working code to match a stale document.

In any of those cases — the blueprint is past its own freshness date, the versions it
was checked against are not the ones installed, or this project did something else on
purpose and it worked — end by asking whether to write the project's own version of
it. The `blueprint-author` skill does that: it records what
differs and why, and leaves the original in place. Ask once and take a no as final;
unasked, the finding lasts as long as this conversation does.

Say which blueprint is being followed, and say where the implementation departs from it.
The silent departure is the expensive one: the next person reads the blueprint and
expects the code to match it.
