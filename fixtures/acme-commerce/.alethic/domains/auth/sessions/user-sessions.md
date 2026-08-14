---
id: "r-000008"
kind: "rule"
title: "User sessions"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/auth.ts"
    symbol: "createSession"
    span:
      - 1
      - 3
    hash: "blake3:f9a12b5be94db237"
order: 1
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

Signing in opens a session that survives 30 idle days, and a user may hold at most five of them at
once.

## How it works
`createSession` stamps the session with `createdAt`, an `expiresAt` 30 days out and the concurrency
limit the session store enforces when a sixth session appears.

## Where it is used
Every authenticated request reads a session created here; the oldest one is dropped when the limit
is reached.

## Invariants
- a session expires after 30 days without activity
- at most five concurrent sessions per user
