# Specrun

Blueprints and skills for the AI you already code with.

A **blueprint** records how a project builds a particular kind of thing — the shape, the
contracts, the failure modes, and why each choice was made. Specrun installs a small set of them
into your project, together with a router skill whose job is to notice when one of them applies.
You keep working in chat as before; when the task matches a blueprint, your agent reads it first
and builds along lines you have already settled instead of designing them again.

It also brings two skills that stand on their own: one that writes a new blueprint out of work
you have just finished, and one that draws the project's architecture as a single HTML file.

Everything is plain markdown in your repository. Nothing calls a model except your agent, in your
chat, on your account.

---

## Install

There are two channels, and they are independent — the marketplace is useful with no CLI at all.

**As a Claude Code plugin** — the blueprints and skills, nothing else:

```
/plugin marketplace add ysz7/specrun
/plugin install specrun@specrun
```

**As a CLI** — the same content, plus installation into one project, a lock file that protects
your edits, and `specrun scan`:

```
uv tool install specrun
cd your-project
specrun init
```

`init` writes the router and the blueprints into `.claude/skills/`, records what it wrote in
`.specrun/lock.json`, and adds the generated map to your `.gitignore`. Commit the rest: what your
agent reads is worth reviewing, and a teammate who clones the repository gets the same answers
without installing anything.

Install one or the other. With both, the same three skills arrive twice under slightly different
names, and the duplicates compete for the same requests.

---

## What you get

| | |
|---|---|
| `blueprints` | the router: reads the task, picks a blueprint or says there is none |
| `blueprint-author` | writes a new blueprint, or your project's own version of a bundled one |
| `map` | draws the architecture as one self-contained HTML file |

The blueprints that ship today cover agent loops, RAG baselines and tool design. They are the
starting set, not the point — the point is the mechanism, and most of the value shows up in the
blueprints you write for your own project.

Installed as a plugin, skills carry the plugin's namespace: `/specrun:map` rather than `/map`.

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

Upgrading is `uv tool upgrade specrun` followed by `specrun sync` in each project. `specrun status`
says when the package carries content newer than what is installed.

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
