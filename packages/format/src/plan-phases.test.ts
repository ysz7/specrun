import { describe, expect, it } from 'vitest';
import { parsePlanPhases, markPhaseDone, setPhaseNote } from './plan-phases.js';

const BODY = `A tiny CLI to-do app.

## Phase 1 — Skeleton
- [x] Package layout
- [x] Entry point

## Phase 2 — Commands
- [ ] add / list
- [ ] done / remove
`;

describe('parsePlanPhases', () => {
  it('parses phases, items and per-item done state', () => {
    const phases = parsePlanPhases(BODY);
    expect(phases.map((p) => p.title)).toEqual(['Phase 1 — Skeleton', 'Phase 2 — Commands']);
    expect(phases[0]!.items).toEqual([
      { text: 'Package layout', done: true },
      { text: 'Entry point', done: true },
    ]);
    expect(phases[1]!.items.map((i) => i.text)).toEqual(['add / list', 'done / remove']);
  });

  it('marks a phase done only when every item is checked', () => {
    const phases = parsePlanPhases(BODY);
    expect(phases[0]!.done).toBe(true);
    expect(phases[1]!.done).toBe(false);
  });
});

describe('markPhaseDone', () => {
  it('ticks only the target phase’s open items, leaving others untouched', () => {
    const out = markPhaseDone(BODY, 1);
    const phases = parsePlanPhases(out);
    expect(phases[1]!.done).toBe(true);
    // Phase 1 unchanged; headings preserved.
    expect(out).toContain('## Phase 1 — Skeleton');
    expect(out).toContain('- [x] add / list');
    expect(out).toContain('- [x] done / remove');
  });

  it('is a no-op for an out-of-range phase index', () => {
    expect(markPhaseDone(BODY, 9)).toBe(BODY);
  });
});

describe('setPhaseNote (the phase records its own outcome, decision 55)', () => {
  it('writes the note under the phase it belongs to and parses back', () => {
    const out = setPhaseNote(BODY, 0, 'done 2026-07-29 · 2 files: todo/cli.py, tests/test_cli.py');
    const phases = parsePlanPhases(out);
    expect(phases[0]!.note).toBe('done 2026-07-29 · 2 files: todo/cli.py, tests/test_cli.py');
    expect(phases[1]!.note).toBeUndefined();
    // the checklist itself is untouched — the note is an aside, not an item
    expect(phases[0]!.items).toHaveLength(2);
    expect(phases[0]!.done).toBe(true);
    expect(out).toContain('## Phase 2 — Commands');
  });

  it('replaces the previous note instead of stacking them', () => {
    const once = setPhaseNote(BODY, 0, 'done · 1 file');
    const twice = setPhaseNote(once, 0, 'done · 1 file · 8 rules mapped into cli/parser');
    expect(twice.match(/^>\s*✓/gm)).toHaveLength(1);
    expect(parsePlanPhases(twice)[0]!.note).toContain('8 rules mapped');
  });

  it('is a no-op for an out-of-range phase index', () => {
    expect(setPhaseNote(BODY, 9, 'done')).toBe(BODY);
  });
});
