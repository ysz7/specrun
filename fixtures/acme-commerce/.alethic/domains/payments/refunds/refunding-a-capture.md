---
id: "r-000005"
kind: "rule"
title: "Refunding a capture"
status: "drift"
provenance: "agent"
anchors:
  - file: "src/payments.ts"
    symbol: "processRefund"
    span:
      - 19
      - 23
    hash: "blake3:c1f16a175031ad97"
    dochash: "blake3:e5731776c2b3357e"
order: 1
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

A refund returns money against what was actually captured and releases the inventory the order had
reserved.

## How it works
`processRefund` clamps the requested amount to the captured amount, then hands the order's reserved
items back to available stock before returning the refunded figure.

## Where it is used
Called from the support flow and from an order cancellation; the inventory release is what checkout
sees on the next read.

## Invariants
- Σ refunds ≤ Σ captures
- reserved inventory is released exactly once per refund

## Edge cases
- A refund larger than the capture is silently clamped, not rejected.

## Drift log
- 2026-07-09 sync: code now allows partial over-refund for B2B accounts (commit abc1234)
