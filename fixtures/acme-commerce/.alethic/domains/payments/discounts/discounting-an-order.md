---
id: "r-000001"
kind: "rule"
title: "Discounting an order"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/payments.ts"
    symbol: "applyDiscounts"
    span:
      - 1
      - 5
    hash: "blake3:19a17192c99b6abf"
    dochash: "blake3:91b3f6e175c9e240"
  - file: "src/payments.ts"
    symbol: "capDiscount"
    span:
      - 15
      - 17
    hash: "blake3:17b20d624bfa3c8c"
    dochash: "blake3:c38e5d9bb2b4e676"
  - file: "src/payments.ts"
    symbol: "computeTax"
    span:
      - 7
      - 9
    hash: "blake3:953475157b5ecb10"
    dochash: "blake3:2660772d22b44ff0"
affects:
  - "r-000014"
order: 1
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

An order is discounted on its subtotal **before tax**, and the discount that survives is capped at
half of that subtotal.

## How it works
`applyDiscounts` takes the order's percentage discount and returns the discounted subtotal;
`capDiscount` clamps any discount to half the subtotal; `computeTax` then runs on the discounted
figure, never on the gross one.

## Where it is used
Called from checkout when the order total is computed, and by promo codes once a code is accepted.

## Invariants
- tax = f(subtotal − discount)
- effective_discount ≤ 0.5 × subtotal

## Edge cases
- A zero subtotal is returned untouched — no discount is applied at all.
