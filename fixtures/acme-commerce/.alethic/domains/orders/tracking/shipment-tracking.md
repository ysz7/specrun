---
id: "r-000018"
kind: "rule"
title: "Shipment tracking"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/orders.ts"
    symbol: "shipmentStatus"
    span:
      - 19
      - 22
    hash: "blake3:6978992487697d0a"
    dochash: "blake3:7c82539d579aad8a"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

A shipment moves forward through pending → shipped → delivered and never regresses.

## How it works
`shipmentStatus` accepts a transition only when the next state's position in that ordered list is at
or beyond the previous one, so a late carrier event cannot walk the shipment backwards.

## Where it is used
Applied to every deduplicated carrier webhook before the order's state is written.

## Invariants
- position(next) ≥ position(prev)

## Edge cases
- A repeated status for the same state is accepted as a no-op.
