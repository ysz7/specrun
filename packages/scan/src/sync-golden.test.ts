import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSyncCases, scoreSyncCases, SYNC_VERDICTS, type SyncVerdict } from './sync-golden.js';

const CASES_DIR = join(process.cwd(), 'fixtures/golden/sync-cases');

describe('sync-case fixtures (agent-prompts-spec §7.4)', () => {
  const cases = loadSyncCases(CASES_DIR);

  it('has at least 5 cases per verdict', () => {
    for (const verdict of SYNC_VERDICTS) {
      const n = cases.filter((c) => c.verdict === verdict).length;
      expect(n, `verdict ${verdict}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('every case is well-formed and its old/new code actually differ', () => {
    for (const c of cases) {
      expect(SYNC_VERDICTS).toContain(c.verdict);
      expect(c.old).not.toBe(c.new);
      expect(c.symbol.length).toBeGreaterThan(0);
      expect(c.rule.length).toBeGreaterThan(0);
    }
  });

  it('has cosmetic-vs-behaviour trap cases marked (the 100% gate)', () => {
    const traps = cases.filter((c) => c.trap);
    expect(traps.length).toBeGreaterThanOrEqual(2);
    expect(traps.some((c) => c.verdict === 'cosmetic')).toBe(true);
    expect(traps.some((c) => c.verdict === 'behavior-changed')).toBe(true);
  });
});

describe('scoreSyncCases', () => {
  const cases = loadSyncCases(CASES_DIR);
  const perfect = new Map<string, SyncVerdict>(cases.map((c) => [c.key, c.verdict]));

  it('passes with 100% accuracy', () => {
    const score = scoreSyncCases(cases, perfect);
    expect(score.accuracy).toBe(1);
    expect(score.trapPass).toBe(true);
    expect(score.pass).toBe(true);
  });

  it('fails the gate when a trap case is missed', () => {
    const wrong = new Map(perfect);
    const trap = cases.find((c) => c.trap && c.verdict === 'cosmetic')!;
    wrong.set(trap.key, 'behavior-changed');
    const score = scoreSyncCases(cases, wrong);
    expect(score.trapPass).toBe(false);
    expect(score.pass).toBe(false);
    expect(score.misses.join(' ')).toContain(trap.key);
  });

  it('reports overall accuracy separately from the trap gate', () => {
    const partial = new Map(perfect);
    const nonTrap = cases.find((c) => !c.trap)!;
    partial.set(nonTrap.key, nonTrap.verdict === 'cosmetic' ? 'rule-outdated' : 'cosmetic');
    const score = scoreSyncCases(cases, partial);
    expect(score.accuracy).toBeLessThan(1);
    expect(score.trapPass).toBe(true); // a non-trap miss doesn't fail the hard gate
  });
});
