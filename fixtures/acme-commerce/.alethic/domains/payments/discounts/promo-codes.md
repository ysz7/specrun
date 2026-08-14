---
id: "r-000002"
kind: "rule"
title: "Promo codes"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/payments.ts"
    symbol: "checkPromoStacking"
    span:
      - 11
      - 13
    hash: "blake3:a7f3637320673dcd"
    dochash: "blake3:beb0cce74c91a0c3"
affects:
  - "r-000001"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

A customer may redeem one promo code per order; codes never stack.

## How it works
`checkPromoStacking` accepts the submitted codes only while there is at most one of them, so the
second code is rejected before any discount is computed.

## Where it is used
Runs ahead of discounting: an accepted code becomes the order's percentage discount.

## Invariants
- at most one promo code applies to an order
