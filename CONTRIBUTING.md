# Contributing

Thanks for looking. This is a small, opinionated project — the rules below are short, and most of
them exist because breaking them cost something real.

## Getting set up

```bash
corepack enable
pnpm install
pnpm doctor     # tells you what is missing before you waste time
pnpm dev
```

You need Node 22.13+, git, and either a [Claude Code](https://claude.com/claude-code) login or
`ANTHROPIC_API_KEY`. Without model access the app builds and starts and then cannot do anything —
`pnpm doctor` checks for this.

## The gate

```bash
pnpm check      # build + test + lint + dep:check
```

Nothing merges unless that is green, and CI runs it on Linux, macOS and Windows. Run it locally
before opening a PR; it takes seconds.

`pnpm test` is deterministic and makes no model calls. The live scenarios (`pnpm dogfood`) do — they
cost tokens and take minutes, and are deliberately outside `pnpm test`. Run them when you change
prompts or the agent pipeline, not on every commit.

## Architecture rules

These are enforced by `pnpm dep:check` and by review, in rough order of how often they get broken.

1. **Imports only point downward.** The renderer may import types from `@alethic/ipc` and nothing
   else of ours; main-process services may import `packages/*`; `packages/*` import nothing of ours
   above them.
2. **`packages/*` never know about Electron.** The core must build as a plain CLI with no Electron
   in its dependency graph. Anything glued to Electron lives in `apps/`.
3. **Types come from `@alethic/format`.** The schema is defined once. Re-export it; never restate it.
4. **Statuses change only through the status machine** (`assertTransition`). The `system` writer may
   only set `stale`, and nothing reaches `drift` without a `## Drift log` entry.
5. **Spec writes go only through the validated MCP tools.** Never hand-write `.alethic/` markdown
   from an agent — the tools are what check schema, transitions and the title norm.
6. **`locked` / `provenance: human` is inviolable.** An agent never overwrites a human-written body;
   at most it offers a diff.
7. **Coverage is never traded, only depth.** A domain that exists in the code cannot be absent from
   the map — absence reads as "this does not exist", which is a lie by omission. Save tokens with a
   shallower scan, never by dropping coverage.

The format itself — schema, status machine, anchors, drift, validator — lives in `packages/format`,
and the reasoning behind each decision is in the doc comments there. Read those before changing how
a node is written or hashed.

## Style

Match the surrounding code: same comment density, naming and idiom. Comments here explain _why_,
especially when the obvious implementation was wrong for a reason that is no longer visible. If you
fix a bug that a test would not have caught, say so in the comment and add the test.

TypeScript is strict everywhere. No `any` escapes, no `@ts-ignore` without a sentence explaining it.

## Pull requests

- One concern per PR. A drive-by refactor inside a bug fix makes both harder to review.
- Explain what you changed and how you verified it. "Tests pass" is not verification; "the phase
  note is now written twice and the second write no longer drops the first" is.
- If you find something outside your PR's scope, mention it in the description or open an issue —
  don't fix it in passing.

## Sign your commits off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) instead
of a CLA. It is one line certifying you have the right to submit the code you are submitting:

```bash
git commit -s -m "your message"
```

which appends `Signed-off-by: Your Name <your@email>`. Set `git config user.name` and
`user.email` first so it matches your commits.

## Licence

By contributing you agree that your contribution is licensed under
[Apache-2.0](LICENSE), the same as the rest of the project. Note that the project name and logo are
not covered by that licence — see [TRADEMARK.md](TRADEMARK.md).
