---
id: "r-000005"
kind: "rule"
title: "Conflicted rule"
status: "ok"
provenance: "agent"
tests:
  - "core.conflict.spec.ts"
order: 5
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

A rule whose body still carries git conflict markers after a messy pull.

<<<<<<< HEAD
The discount applies before tax.
=======
The discount applies after tax for B2B.
>>>>>>> feature/b2b-pricing
