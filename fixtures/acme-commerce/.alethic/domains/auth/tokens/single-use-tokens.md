---
id: "r-000012"
kind: "rule"
title: "Single-use tokens"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/auth.ts"
    symbol: "consumeToken"
    span:
      - 13
      - 16
    hash: "blake3:b0ec0c994a3aec30"
    dochash: "blake3:7b4374a2d199924a"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

A one-time token can be spent exactly once; a second attempt is rejected loudly.

## How it works
`consumeToken` throws when the token is already marked used, and marks it used otherwise — the check
and the mark happen together, so a replay cannot slip between them.

## Where it is used
Password resets and e-mail confirmations both spend their token through this path.

## Invariants
- a token is accepted at most once
- reuse raises an error rather than failing silently
