---
id: "r-000011"
kind: "rule"
title: "Token rotation"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/auth.ts"
    symbol: "rotateTokenOnPasswordChange"
    span:
      - 9
      - 11
    hash: "blake3:5d0e798708b09979"
    dochash: "blake3:c4e24ae921f7066a"
order: 1
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

Changing a password invalidates every token issued before it.

## How it works
`rotateTokenOnPasswordChange` bumps the user's `tokenVersion`; tokens carry the version they were
minted with, so every older token stops validating at once.

## Where it is used
Runs inside the password-change flow, before the response is returned.

## Invariants
- no token minted before a password change is ever accepted after it
