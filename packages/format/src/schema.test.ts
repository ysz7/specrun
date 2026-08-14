import { describe, expect, it } from 'vitest';
import { Config, Rule, schemaForKind } from './schema.js';

const baseRule = {
  id: 'r-9be1f2',
  kind: 'rule' as const,
  title: 'Discount applies before tax',
  status: 'ok' as const,
  provenance: 'agent' as const,
  created: '2026-07-09T12:00:00Z',
  updated: '2026-07-09T12:00:00Z',
  updated_by: 'scanner' as const,
};

describe('schema (format-spec §4)', () => {
  it('accepts a valid rule and fills array defaults', () => {
    const parsed = Rule.parse(baseRule);
    expect(parsed.locked).toBe(false);
    expect(parsed.anchors).toEqual([]);
    expect(parsed.affects).toEqual([]);
    expect(parsed.tests).toEqual([]);
  });

  it('rejects a malformed id', () => {
    expect(Rule.safeParse({ ...baseRule, id: 'rule-XYZ' }).success).toBe(false);
  });

  it('rejects a plan-step status on a rule', () => {
    expect(Rule.safeParse({ ...baseRule, status: 'planned' }).success).toBe(false);
  });

  it('rejects an anchor hash of the wrong shape', () => {
    const bad = { ...baseRule, anchors: [{ file: 'a.ts', hash: 'sha1:abc' }] };
    expect(Rule.safeParse(bad).success).toBe(false);
  });

  it('schemaForKind selects the matching schema', () => {
    expect(schemaForKind('rule')).toBe(Rule);
  });

  it('config applies documented defaults', () => {
    const cfg = Config.parse({ format: 1 });
    expect(cfg.language).toBe('en');
    expect(cfg.limits.max_rules_per_sub).toBe(40);
  });
});
