# fixtures

Reference `.alethic/` maps and golden repos used by tests and prompt calibration.

- `acme-commerce/` — hand-written reference `.alethic/`: the shape a map should have. Its nodes are
  **features** (decision 56) — a name, a responsibility, `## How it works` / `## Where it is used` /
  `## Invariants` — not one node per assertion. Whatever this fixture looks like is what the tests
  and the prompt examples pull the product towards, so keep it in the current form.
- `edge-cases/` — locked file, conflict markers, rule without anchors, broken anchor, shallow domain
  (Phase 1). Deliberately *not* migrated to the feature form: `shallow-rule.md` is a bare statement
  with no sections, so it is also the fixture for the old-form audit (`legacy-form`, format-spec §9).
- `golden/` — real mini source projects + expected maps for scanner/sync regression. `expected/*.json`
  lists the features a scan should land, with the anchor symbols each is made of; scoring also checks
  the form (assertion-shaped titles, fragmentation) so a run cannot pass by rebuilding the old map.
