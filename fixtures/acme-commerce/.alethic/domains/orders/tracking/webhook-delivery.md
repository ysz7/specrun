---
id: "r-000017"
kind: "rule"
title: "Webhook delivery"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/orders.ts"
    symbol: "dedupeWebhook"
    span:
      - 15
      - 17
    hash: "blake3:5bb65173b5d5d2a9"
    dochash: "blake3:19bb1eb0effd40a3"
order: 1
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

Carrier webhooks are applied once per event: a re-delivery of the same event id is dropped for 24
hours.

## How it works
`dedupeWebhook` checks the event id against the ids seen inside the dedupe window and reports the
repeat, so the handler can skip it before any state changes.

## Where it is used
Guards the shipment-status handler, which carriers retry aggressively.

## Invariants
- an event id is acted on at most once within 24 hours

## Edge cases
- An event arriving after the window is treated as new and applied again.
