import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_CONTAINER_BODY } from './form.js';
import { validateDir, validateNodes, type LoadedFile } from './validate.js';
import type { RuleMeta } from './schema.js';

const ACME = join(process.cwd(), 'fixtures/acme-commerce/.alethic');
const EDGE = join(process.cwd(), 'fixtures/edge-cases/.alethic');

const rule = (over: Partial<RuleMeta> & { id: string }): RuleMeta => ({
  kind: 'rule',
  title: 'A rule',
  status: 'ok',
  provenance: 'agent',
  locked: false,
  anchors: [],
  affects: [],
  tests: [],
  created: '2026-07-09T12:00:00Z',
  updated: '2026-07-09T12:00:00Z',
  updated_by: 'scanner',
  ...over,
});
const file = (meta: RuleMeta, body: string, path = `${meta.id}.md`): LoadedFile => ({
  path,
  meta,
  body,
  conflict: false,
});
const codes = (files: LoadedFile[]): string[] =>
  validateNodes(files)
    .issues.filter((i) => i.level === 'error')
    .map((i) => i.code);

describe('validator error categories (format-spec §7)', () => {
  it('parse-error', () => {
    const bad: LoadedFile = {
      path: 'x.md',
      meta: null,
      body: '',
      conflict: false,
      parseError: 'boom',
    };
    expect(codes([bad])).toContain('parse-error');
  });

  it('duplicate-id', () => {
    const a = file(rule({ id: 'r-000001' }), 'Statement.', 'a.md');
    const b = file(rule({ id: 'r-000001' }), 'Statement.', 'b.md');
    expect(codes([a, b])).toContain('duplicate-id');
  });

  it('affects-missing', () => {
    const a = file(rule({ id: 'r-000001', affects: ['r-999999'] }), 'Statement.');
    expect(codes([a])).toContain('affects-missing');
  });

  it('no-statement', () => {
    const a = file(rule({ id: 'r-000001' }), '## Invariants\n- only sections, no statement');
    expect(codes([a])).toContain('no-statement');
  });

  it('drift-no-log', () => {
    const a = file(
      rule({ id: 'r-000001', status: 'drift' }),
      'A drifting statement with no drift log.',
    );
    expect(codes([a])).toContain('drift-no-log');
  });

  it('accepts a drift rule that carries a Drift log entry', () => {
    const a = file(
      rule({ id: 'r-000001', status: 'drift' }),
      'A statement.\n\n## Drift log\n- 2026-07-09 sync: diverged (commit abc123)',
    );
    expect(codes([a])).not.toContain('drift-no-log');
  });
});

// Decision 56: the title is a name and a container is one thought (3–7 children). The tools reject
// both on the way in; the validator is what sees what older scans already left on disk.
describe('validator form warnings (decision 56)', () => {
  const warns = (files: LoadedFile[]): string[] =>
    validateNodes(files)
      .issues.filter((i) => i.level === 'warn')
      .map((i) => i.code);

  it('warns about a title that is an assertion, not a name', () => {
    const long = file(
      rule({ id: 'r-000001', title: 'a'.repeat(71) }),
      'Statement.',
      'domains/d/s/a.md',
    );
    const period = file(
      rule({ id: 'r-000002', title: 'Discount applies before tax.' }),
      'Statement.',
      'domains/d/s/b.md',
    );
    const code = file(
      rule({ id: 'r-000003', title: 'Adding a `task`' }),
      'Statement.',
      'domains/d/s/c.md',
    );
    for (const f of [long, period, code]) expect(warns([f])).toContain('title-not-a-name');
  });

  it('a feature name inside the norm draws no warning', () => {
    const ok = file(
      rule({ id: 'r-000001', title: 'Adding a task' }),
      'Statement.',
      'domains/d/s/a.md',
    );
    expect(warns([ok])).not.toContain('title-not-a-name');
  });

  it('warns when a container grows wider than ~7 children (time for a layer)', () => {
    const ts = '2026-07-09T12:00:00Z';
    const base = { created: ts, updated: ts, updated_by: 'scanner' as const };
    const sub: LoadedFile = {
      path: 'domains/payments/discounts/_sub.md',
      meta: { id: 's-000001', kind: 'sub', title: 'Discounts', ...base },
      body: 'Discounts.',
      conflict: false,
    };
    const feature = (n: number): LoadedFile =>
      file(
        rule({ id: `r-00000${n}`, title: `Feature ${n}`, tests: ['t.spec.ts'] }),
        'Statement.',
        `domains/payments/discounts/feature-${n}.md`,
      );
    const seven = [sub, ...[1, 2, 3, 4, 5, 6, 7].map(feature)];
    expect(warns(seven)).not.toContain('container-too-wide');
    expect(warns([...seven, feature(8)])).toContain('container-too-wide');
  });

  // `SpecStore.ensureContainers` auto-creates a domain/sub card with placeholder text when a
  // feature lands under a container that does not exist yet. Seen live: after a migration the
  // sub-branch roofs said real things while the domain card still carried this text, and
  // `container-without-statement` stayed silent because the body was non-empty (PLAN.md known
  // issues) — the placeholder is words, but it is not the container's own thought.
  it('a domain/sub card still carrying its auto-created placeholder warns container-without-statement', () => {
    const ts = '2026-07-09T12:00:00Z';
    const domain: LoadedFile = {
      path: 'domains/payments/_domain.md',
      meta: {
        id: 'd-000001',
        kind: 'domain',
        title: 'Payments',
        scope: ['src/payments/**'],
        created: ts,
        updated: ts,
        updated_by: 'system',
      },
      body: PLACEHOLDER_CONTAINER_BODY.domain,
      conflict: false,
    };
    const sub: LoadedFile = {
      path: 'domains/payments/discounts/_sub.md',
      meta: {
        id: 's-000001',
        kind: 'sub',
        title: 'Discounts',
        created: ts,
        updated: ts,
        updated_by: 'system',
      },
      body: PLACEHOLDER_CONTAINER_BODY.sub,
      conflict: false,
    };
    expect(warns([domain])).toContain('container-without-statement');
    expect(warns([sub])).toContain('container-without-statement');

    // A real assertion, even a short one, does not trip the check.
    const described: LoadedFile = { ...domain, body: 'Everything about money leaving the store.' };
    expect(warns([described])).not.toContain('container-without-statement');
  });
});

describe('anchor file paths normalize backslashes before resolving (Windows-vs-POSIX)', () => {
  const repoRoot = join(process.cwd(), 'fixtures/acme-commerce');

  it('a backslash anchor path resolves against a real file, no broken-anchor warning', () => {
    const a = file(
      rule({ id: 'r-000001', anchors: [{ file: 'src\\payments.ts', hash: 'x' }] }),
      'Statement.',
      'domains/d/s/a.md',
    );
    const result = validateNodes([a], { repoRoot });
    expect(result.issues.map((i) => i.code)).not.toContain('broken-anchor');
  });

  it('a genuinely missing file still warns broken-anchor', () => {
    const a = file(
      rule({ id: 'r-000001', anchors: [{ file: 'src\\does-not-exist.ts', hash: 'x' }] }),
      'Statement.',
      'domains/d/s/a.md',
    );
    const result = validateNodes([a], { repoRoot });
    expect(result.issues.map((i) => i.code)).toContain('broken-anchor');
  });
});

describe('validate fixtures (Phase 1 DoD)', () => {
  it('acme-commerce is clean (0 errors, 0 warnings)', () => {
    const result = validateDir(ACME);
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('edge-cases passes with exactly the expected warnings', () => {
    const result = validateDir(EDGE);
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    const warnCodes = new Set(result.issues.filter((i) => i.level === 'warn').map((i) => i.code));
    expect(warnCodes).toEqual(
      new Set(['conflict', 'broken-anchor', 'no-anchors-no-tests', 'slug-mismatch']),
    );
  });
});
