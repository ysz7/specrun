---
id: "r-000014"
kind: "rule"
title: "Order totals"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/orders.ts"
    symbol: "orderTotal"
    span:
      - 7
      - 9
    hash: "blake3:9228122e379e4986"
    dochash: "blake3:aae2d330d2634878"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

The amount a customer owes is the sum of the cart's item prices, floored at zero.

## How it works
`orderTotal` reduces the cart items into a sum and clamps it with `Math.max(0, …)`, so an
over-generous discount can zero the order out but never turn it into a payout.

## Where it is used
Computed by checkout for the order it creates; the same figure is what refunds are measured against.

## Invariants
- total ≥ 0

## Edge cases
- An empty cart totals zero rather than failing.
