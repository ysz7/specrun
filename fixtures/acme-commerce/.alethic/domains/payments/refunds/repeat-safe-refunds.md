---
id: "r-000006"
kind: "rule"
title: "Repeat-safe refunds"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/payments.ts"
    symbol: "refundIdempotencyKey"
    span:
      - 25
      - 27
    hash: "blake3:b6708a8f3224562a"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

A refund request repeated for the same refund id pays out once; the retry is idempotent.

## How it works
`refundIdempotencyKey` derives the key `refund:<refundId>`, and the payment provider treats a second
call under the same key as the first one's result.

## Where it is used
Every refund goes through the key, so support retries and webhook redeliveries share it.

## Invariants
- one payout per refund id, however many times it is requested
