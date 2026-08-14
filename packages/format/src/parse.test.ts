import { describe, expect, it } from 'vitest';
import { parse, parseConfig, ParseError } from './parse.js';
import { serialize } from './serialize.js';
import { isPlanStep, isRule, type RuleMeta } from './schema.js';

const frontmatter = (extra: string): string => `---
id: r-000001
kind: rule
title: A valid title
status: ok
provenance: agent
updated_by: scanner
created: 2026-07-09T12:00:00Z
updated: 2026-07-09T12:00:00Z
${extra}---

A statement.
`;

describe('parse errors (non-conflict)', () => {
  it('throws ParseError on an unknown kind', () => {
    expect(() => parse('---\nkind: wat\nid: x-000000\n---\nbody')).toThrow(ParseError);
  });

  it('throws ParseError on schema violation and carries zod issues', () => {
    try {
      parse('---\nid: bad\nkind: rule\ntitle: x\n---\nbody');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).issues?.length).toBeGreaterThan(0);
    }
  });
});

describe('parse survives conflict markers in the frontmatter', () => {
  it('returns a null meta but keeps raw text', () => {
    const text =
      '---\nid: r-000001\nkind: rule\n<<<<<<< HEAD\ntitle: A\n=======\ntitle: B\n>>>>>>> other\n---\nbody';
    const parsed = parse(text);
    expect(parsed.conflict).toBe(true);
    expect(parsed.meta).toBeNull();
    expect(parsed.raw).toBe(text);
  });
});

describe('parseConfig', () => {
  it('parses config.yaml with defaults', () => {
    const cfg = parseConfig('format: 1\nlanguage: ru\n');
    expect(cfg.format).toBe(1);
    expect(cfg.language).toBe('ru');
    expect(cfg.limits.max_rules_per_sub).toBe(40);
  });
});

describe('serialize covers all present optionals', () => {
  it('emits locked, anchors, affects, tests and order when set', () => {
    const meta = parse(
      frontmatter(
        'locked: true\norder: 2\naffects:\n  - r-000002\ntests:\n  - a.spec.ts\nanchors:\n  - file: a.ts\n    symbol: f\n    span:\n      - 1\n      - 3\n    hash: blake3:0123456789abcdef\n',
      ),
    ).meta as RuleMeta;
    const text = serialize({ meta, body: 'A statement.' });
    expect(text).toContain('locked: true');
    expect(text).toContain('order: 2');
    expect(text).toContain('r-000002');
    expect(text).toContain('a.spec.ts');
    expect(text).toContain('blake3:0123456789abcdef');
    expect(isRule(meta)).toBe(true);
    expect(isPlanStep(meta)).toBe(false);
  });
});

// Found by CI on a Windows runner: GitHub's Windows checkout applies core.autocrlf=true, so every
// `.alethic/` file arrived as CRLF and gray-matter's frontmatter split failed on all of them — the
// map read as completely empty, 56 tests down. The same commit was green on the author's Windows
// machine, whose working copy still held LF, so nothing local could have caught it. CRLF is an
// artifact of the filesystem a file crossed, not a dialect of the format.
describe('CRLF line endings (Windows checkouts, Windows editors)', () => {
  const crlf = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

  it('parses a node whose every line ends in CRLF', () => {
    const node = frontmatter('');
    const parsed = parse(crlf(node));
    expect(parsed.meta?.id).toBe('r-000001');
    expect(parsed.meta?.kind).toBe('rule');
    expect(parsed.body.trim()).toBe('A statement.');
  });

  it('gives a CRLF file the same meta and body as its LF twin', () => {
    const node = frontmatter('');
    const lf = parse(node);
    const crlfParsed = parse(crlf(node));
    expect(crlfParsed.meta).toEqual(lf.meta);
    expect(crlfParsed.body).toBe(lf.body); // bodies are normalized, so they compare equal
    expect(crlfParsed.raw).toContain('\r\n'); // …but `raw` still holds the bytes as they were
  });

  it('parses a CRLF config.yaml', () => {
    const config = parseConfig(crlf('format: 1\nlanguage: en\nstack: []\n'));
    expect(config.format).toBe(1);
    expect(config.language).toBe('en');
  });

  it('still flags conflict markers when the file is CRLF', () => {
    const conflicted = crlf(
      `---\nid: r-000005\nkind: rule\n---\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n`,
    );
    expect(parse(conflicted).conflict).toBe(true);
  });
});
