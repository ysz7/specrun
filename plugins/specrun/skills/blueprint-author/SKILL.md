---
name: blueprint-author
description: Use when someone wants a *blueprint* written or revised — this project's reusable, forward-looking record of how it builds a given kind of thing, meant to guide the next feature of that kind. Trigger on any request naming a blueprint: "make a blueprint out of what we built", "record this decision/why we chose X as a blueprint", "add a local blueprint for how we do Y here", "override that blueprint with our own version". Trigger equally when a blueprint is complained about — stale, past its freshness window, pinned to uninstalled versions, or out of step with how the team now works. Also consider offering it unprompted after shipping a new module or entry point that settled a non-obvious architectural question. Capturing rationale — why one approach won over another — counts, and so does a blueprint that is only a decision record. Not for READMEs, contributing guides, docstrings, commit messages, design docs for unbuilt work, or generalizing a single half-finished experiment.
---

# Writing a blueprint

A blueprint says how this project builds a particular kind of thing: the shape, the contracts,
the failure modes, and the reasoning behind each choice. Its readers are agents and people
starting the *next* feature of that kind, which is what separates it from documentation — docs
explain the code that exists, a blueprint carries a decision forward to code that does not exist
yet.

That difference decides almost everything below. A blueprint written from too little evidence
does real damage: it hardens one accident into a rule, and the next three features inherit it
without anyone remembering it was a guess.

## Two ways this starts

**The developer asks.** "Write a blueprint for what we just did", "record this as a blueprint",
"our retrieval blueprint is out of date". Go to *Is there enough here* below.

**You propose it.** After finishing a substantial piece of work, when all of these hold:

- the work added a new module or a new entry point, rather than editing something that already
  existed
- it settled a question that had more than one defensible answer — a boundary, a contract, a
  retry policy, a storage shape — and the reasons for the answer are still fresh
- the next feature of the same kind is plausible in this repository

Offer once, in a sentence, and take a no as final for the rest of the session. Repeating the
offer is how a helpful skill turns into one the developer disables on the first day, and a
disabled skill records nothing at all. If any of the three conditions is missing — the change was
a fix, a rename, a dependency bump, a bit of glue — say nothing.

## Is there enough here to generalise?

Ask this before asking anything else, and answer it out loud.

With a single implementation in front of you, the general and the specific are not yet separable.
Every detail looks essential because there is nothing to contrast it against: you cannot tell the
decision that will hold for the next case from the one that fell out of this week's deadline, this
one library version, or this one customer's data.

When that is the situation, say so plainly and offer the two honest options:

- **record the decisions only** — a short blueprint that states what was chosen and why, with the
  constraints that forced it, and no claim about how to build the next one. This is genuinely
  useful: the reasoning is what evaporates first.
- **wait for the second case** — note the intent, revisit when something similar gets built, and
  write the full blueprint from two examples, where the common part is visible rather than
  guessed.

Let the developer choose. Writing a confident full blueprint from one instance anyway is the main
failure mode of this skill.

## Ask before you write

A blueprint is mostly reasoning, and the reasoning is in the developer's head, not in the diff.
The code shows what was chosen; it almost never shows what was rejected, and the rejected options
are half of what makes a blueprint worth reading.

Worth asking, picking the two or three that actually bite here:

- what else was considered, and what ruled it out — cost, latency, an existing dependency, a
  constraint from elsewhere in the system
- what would have to change for this decision to be wrong
- which parts are deliberate and which are "it works, we did not think hard about it" — the second
  kind should not enter a blueprint as though it were settled
- what broke on the way, and what is likely to break next
- which library and service versions this was actually checked against

Read the code that was written before asking, so the questions are about the decisions rather than
about facts already on disk.

## What goes in the file

Write the reusable decision with its reasoning — not a tour of the module. A retelling of the code
goes stale on the next refactor and helps nobody; the reason a boundary sits where it sits stays
true much longer.

A blueprint usually wants: the problem it solves; the shape (components and how they fit); the
contracts between them; the settled decisions with their rationale; failure modes with how each
one shows up; and what to check before trusting it. Skip any of those that this subject does not
have — an empty section that exists to satisfy a template is worse than its absence, since it
reads as "nothing to say here" when it means "nobody knew".

Point at real files in this repository for the reference implementation instead of inventing
sample code. Code that exists is checkable and stays honest as it changes.

### Format

The file goes in `.specrun/local/blueprints/<id>.md` — the folder this project owns. Specrun reads
that folder and never writes it, so nothing here is at risk of being overwritten by an upgrade.

It opens with a TOML header fenced by `+++`:

```
+++
id = "http-clients"
title = "HTTP clients"
use_when = "Calling an external HTTP API from this codebase; adding a client, or one is timing out, retrying wrongly, or leaking connections"
origin = "local"
verified_at = 2026-08-14
stale_after = "90d"
verified_against = { httpx = "0.27.x" }
+++
```

- `id` — lowercase, hyphenated, unique among the blueprints installed here. Reusing the `id` of a
  bundled blueprint is not an accident to avoid but a deliberate act; see *Overriding* below.
- `use_when` — the one line the router matches a task against, so it decides whether this blueprint
  is ever read. Write it as the situation and the symptoms, in the words someone would use when
  they are in the middle of it, not as the name of the topic. Compare "Caching" with "A page is
  slow because it recomputes the same query per request; adding or fixing a cache layer".
- `verified_at` — a bare date, not a string.
- `stale_after` — how long the claim of freshness is good for: `90d`, `12w`, `6m`, `1y`. Leaving it
  out means the blueprint never goes stale, which is a real claim; make it deliberately.
- `verified_against` — the versions the approach was actually checked against. This is what makes
  going stale detectable later instead of a matter of opinion.

Then the markdown body, starting with an `#` heading.

### After writing

If this project has the Specrun CLI, `specrun sync` installs the new blueprint next to the router
so the agent can find it; without that step the file exists but nothing points at it. If the CLI
is not installed here, say that the blueprint is written and how the project would pick it up.

## Overriding a bundled blueprint

An override is a local blueprint that reuses a bundled blueprint's `id`. The local one wins, and
the original stays untouched — nothing is edited or deleted, it is shadowed, and `specrun status`
shows the shadowing so the change stays explainable months later.

Propose one only on a trigger that can be checked by someone else:

- the blueprint is past `verified_at` + `stale_after`, or its `verified_against` pins disagree with
  the versions actually installed in this project
- the developer went against the blueprint's approach on purpose, did it another way, and the
  result passed its tests
- the developer asked for a different style

"There seems to be a better way" is not one of them, however strong the impression. A blueprint is
the record of a decision somebody made with context you do not have; replacing it on a hunch turns
a settled question back into an open one, and the project ends up with two answers and no memory
of why either was chosen. If a better approach really is at hand, say so and let the developer
decide — that request then becomes the trigger.

An override carries one extra header field naming what it replaces, so the lineage survives:

```
based_on = "rag-baseline@0.1.0"
```

The version after `@` is the `content_version` the original came from — `specrun status` prints it.

Say in the body what differs from the original and why. An override that reads as a fresh
blueprint loses the very thing that justified it: the disagreement.
