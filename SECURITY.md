# Security policy

## Reporting a vulnerability

Please report privately, not in a public issue: use **GitHub's private vulnerability reporting**
(the _Security_ tab → _Report a vulnerability_) or email the address on the maintainer's GitHub
profile.

Include what you did, what happened, and what you expected. A proof of concept helps. You will get
an acknowledgement within a few days; this is a small project, so please allow reasonable time for
a fix before disclosing publicly.

## What this project actually does

Read this before deciding whether something is a vulnerability — for a tool like this, a lot of
alarming-looking behaviour is the documented design.

Alethic drives a coding agent that, **by design**, reads your source, writes files in your project
and runs shell commands in it. That capability is the product. It is bounded like this:

- **Per-role tool sandboxes.** Each agent role gets only the tools its job needs. The Navigator is
  read-only. The Scanner writes spec, never code.
- **Permission prompts.** The first file write and the first shell command in a session ask you,
  with three answers: allow once, deny, allow for this session. Session grants are listed in
  Settings and can be revoked, and they reset when you switch projects.
- **Auto-accept is opt-in and narrow.** It covers file edits only; commands still ask every time.
- **Snapshots before destructive spec operations.** Rescan, deepen and migrate copy `.alethic/`
  into `.alethic/.backup/` first, and the last five whole-map snapshots are kept.
- **Validated write path.** Everything the agent writes to `.alethic/` goes through tools that
  check schema, status transitions and provenance. Human-authored nodes cannot be overwritten by
  an agent — at most it proposes a diff.
- **No telemetry.** The app collects nothing and contacts no server of ours. Your code and prompts
  go to Anthropic's API under the terms of your own Claude account.

## In scope

- Escaping a role's tool sandbox, or performing a write the role should not be able to perform.
- Bypassing the permission prompt for a write or a command that should have asked.
- Overwriting a `locked` / human-authored node through an agent path.
- Prompt injection **from scanned source code** that causes actions outside the current scope —
  for example a comment in a scanned file that makes the agent write outside the project, exfiltrate
  file contents, or run a command the user was never asked about.
- Path traversal out of the project root, or writes to `.alethic/` that corrupt the map without
  validation.
- Leaking credentials (API keys, tokens) into logs, the map, or diagnostics output.

## Not in scope

- The agent editing your files or running commands **after you granted permission** — that is the
  feature.
- Anything requiring an attacker who already has local access to your machine or your account.
- Vulnerabilities in Anthropic's API or the Claude Agent SDK — report those to Anthropic.
- Unsigned builds triggering Gatekeeper or SmartScreen warnings. Known and documented; code signing
  is a distribution decision, not a defect.

## Supported versions

The project is pre-1.0 and under active development. Fixes land on `main`; there are no backports
to older tags.
