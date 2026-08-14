---
id: "ps-000002"
kind: "plan-step"
title: "Endpoint POST promo apply"
status: "planned"
accept:
  - "run: pnpm test promo"
  - "200 on a valid code, 422 on an expired one"
depends_on:
  - "ps-000001"
order: 2
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

Add POST /promo/apply with code validation.

## Notes
