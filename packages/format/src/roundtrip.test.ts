import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasConflictMarkers, parse } from './parse.js';
import { serialize } from './serialize.js';
import { loadAlethicDir } from './load.js';

const ACME = join(process.cwd(), 'fixtures/acme-commerce/.alethic');
const EDGE = join(process.cwd(), 'fixtures/edge-cases/.alethic');

describe('parse ↔ serialize round-trip', () => {
  it('is idempotent and meta-preserving on a hand-written node', () => {
    const text = readFileSync(
      join(ACME, 'domains/payments/discounts/discounting-an-order.md'),
      'utf8',
    );
    const p1 = parse(text);
    const s1 = serialize({ meta: p1.meta!, body: p1.body });
    const p2 = parse(s1);
    const s2 = serialize({ meta: p2.meta!, body: p2.body });
    expect(s2).toBe(s1); // byte-stable
    expect(p2.meta).toEqual(p1.meta); // lossless
  });

  it('keeps ISO datetimes as strings (never coerced to Date)', () => {
    const text = readFileSync(join(ACME, 'alethic.md'), 'utf8');
    const meta = parse(text).meta!;
    expect(typeof meta.created).toBe('string');
    expect(meta.created).toBe('2026-07-09T12:00:00Z');
  });

  it('re-serializes every acme node identically', () => {
    for (const node of loadAlethicDir(ACME).nodes) {
      if (!node.meta) continue;
      const again = serialize({ meta: node.meta, body: node.body });
      const reparsed = parse(again);
      expect(serialize({ meta: reparsed.meta!, body: reparsed.body })).toBe(again);
    }
  });

  it('survives git conflict markers with a conflict flag (decision 41)', () => {
    const text = readFileSync(join(EDGE, 'domains/core/rules/conflicted-rule.md'), 'utf8');
    expect(hasConflictMarkers(text)).toBe(true);
    const parsed = parse(text);
    expect(parsed.conflict).toBe(true);
    expect(parsed.meta?.id).toBe('r-000005'); // frontmatter still parsed
    expect(parsed.raw).toContain('<<<<<<<');
  });
});
