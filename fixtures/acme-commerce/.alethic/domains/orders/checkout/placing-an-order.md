---
id: "r-000013"
kind: "rule"
title: "Placing an order"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/orders.ts"
    symbol: "checkout"
    span:
      - 1
      - 5
    hash: "blake3:1ff2532d9bd18894"
  - file: "src/orders.ts"
    symbol: "checkoutIdempotencyKey"
    span:
      - 11
      - 13
    hash: "blake3:c6396a7726665b27"
order: 1
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

Checkout turns a cart into an order only once payment has been captured, and a resubmitted checkout
produces the same order rather than a second one.

## How it works
`checkout` refuses an uncaptured payment and a guest cart without an e-mail, then returns the order
total together with the key from `checkoutIdempotencyKey` (`checkout:<cartId>`), which the order
store uses to recognise a retry.

## Where it is used
The single entry point from the storefront; the key it returns is what the payment webhook matches
against.

## Invariants
- an order exists only against a captured payment
- a guest checkout supplies an e-mail address
- one order per cart id, however many times checkout is submitted

## Edge cases
- A retry after a network failure returns the original order, not a duplicate charge.
