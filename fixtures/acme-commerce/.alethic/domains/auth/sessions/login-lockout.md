---
id: "r-000009"
kind: "rule"
title: "Login lockout"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/auth.ts"
    symbol: "lockAfterFailures"
    span:
      - 5
      - 7
    hash: "blake3:0a5600468271874a"
    dochash: "blake3:2e43c701f6db9e7b"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

Three consecutive failed logins lock the account instead of letting the attempts continue.

## How it works
`lockAfterFailures` reports the lock as soon as the failure counter reaches three; the counter is
reset by a successful sign-in.

## Where it is used
Consulted by the sign-in path before a session is created.

## Invariants
- the account locks at the third consecutive failure, not the fourth
