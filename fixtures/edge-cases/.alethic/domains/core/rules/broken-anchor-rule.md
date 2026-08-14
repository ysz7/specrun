---
id: "r-000003"
kind: "rule"
title: "Broken anchor rule"
status: "ok"
provenance: "agent"
anchors:
  - file: "src/deleted/gone.ts"
    symbol: "vanished"
    span:
      - 1
      - 3
    hash: "blake3:19a17192c99b6abf"
order: 3
created: "2026-07-09T12:00:00Z"
updated: "2026-07-09T12:00:00Z"
updated_by: "scanner"
---

This rule anchors a symbol whose file no longer exists in the repo.
