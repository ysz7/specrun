---
name: blueprints
description: Architectural blueprints this project has already settled on, covering agent loop, rag baseline and tool design. Use when building, extending or fixing a feature in one of those areas, so the work follows the recorded approach and its reasoning instead of being designed again from scratch. Not for topics with no blueprint here, and not for ordinary coding questions.
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
| [Agent loop](blueprints/agent-loop.md) | Building the loop that calls a model, runs the tools it asks for and repeats until it stops; or an agent runs away, loops, or will not stop on its own |
| [RAG baseline](blueprints/rag-baseline.md) | Answers have to come from a document corpus the model was not trained on, the corpus changes, or answers must cite their sources; retrieval is being set up, or the model hallucinates and cannot attribute what it says |
| [Tool design](blueprints/tool-design.md) | An agent has more than one tool and picks the wrong one, sends malformed arguments, or misreads what a tool returned; tool schemas, descriptions and return shapes are being written or reworked |

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
