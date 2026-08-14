import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch, buildIndex, toEntryMap } from './index-builder.js';
import { loadAlethicDir, toIndexEntries } from './load.js';
import type { RuleMeta } from './schema.js';

const ACME = join(process.cwd(), 'fixtures/acme-commerce/.alethic');
const EDGE = join(process.cwd(), 'fixtures/edge-cases/.alethic');

const acmeEntries = () => toIndexEntries(loadAlethicDir(ACME).nodes);
const frozen = () => '1970-01-01T00:00:00Z';

describe('buildIndex (format-spec §6)', () => {
  const index = buildIndex(acmeEntries(), frozen);

  it('indexes every node', () => {
    // 1 root + 2 sections + 3 domains + 6 subs + 12 features + 1 plan + 2 steps (decision 56)
    expect(Object.keys(index.nodes)).toHaveLength(27);
    expect(index.nodes['a-000001']!.kind).toBe('root');
    expect(index.nodes['a-000001']!.parent).toBeUndefined();
  });

  it('derives parent/child structure from the folder layout', () => {
    expect(index.nodes['d-000001']!.parent).toBe('sec-000002'); // domains hang under "Code"
    expect(index.nodes['s-000001']!.parent).toBe('d-000001');
    expect(index.nodes['r-000001']!.parent).toBe('s-000001');
    expect(index.nodes['p-000001']!.parent).toBe('sec-000001'); // plans under "Plan"
    expect(index.tree['a-000001']).toEqual(['sec-000001', 'sec-000002']);
    expect(index.tree['sec-000002']).toEqual(
      expect.arrayContaining(['d-000001', 'd-000002', 'd-000003']),
    );
  });

  it('maps anchor files to rule ids (by_file)', () => {
    expect(index.by_file['src/payments.ts']).toEqual(
      expect.arrayContaining(['r-000001', 'r-000002', 'r-000005', 'r-000006']),
    );
  });

  it('inverts affects into affected_by', () => {
    expect(index.affected_by['r-000014']).toEqual(['r-000001']); // discounting → order totals
    expect(index.affected_by['r-000001']).toEqual(['r-000002']); // promo codes → discounting
  });

  it('rolls the worst descendant status up to ancestors (§1.3)', () => {
    expect(index.rollup['a-000001']!.worst).toBe('drift'); // r-000005 is drift
    expect(index.rollup['a-000001']!.n).toBe(14); // 12 features + 2 plan steps
    expect(index.rollup['d-000001']!.worst).toBe('drift');
    expect(index.rollup['d-000002']!.worst).toBe('ok');
  });
});

describe('incremental patch', () => {
  it('re-rolls status when one file changes, without re-reading the rest', () => {
    const map = toEntryMap(acmeEntries());
    const before = buildIndex([...map.values()], frozen);
    expect(before.rollup['a-000001']!.worst).toBe('drift');

    const drifted = map.get('domains/payments/refunds/refunding-a-capture.md')!;
    const healed: RuleMeta = { ...(drifted.meta as RuleMeta), status: 'ok' };
    applyPatch(map, { path: drifted.path, entry: { path: drifted.path, meta: healed } });

    const after = buildIndex([...map.values()], frozen);
    // no more drift anywhere → worst bubbles up to the planned steps
    expect(after.rollup['a-000001']!.worst).toBe('planned');
    expect(after.rollup['d-000001']!.worst).toBe('ok');
  });
});

describe('Plan/Code sections (decision 55)', () => {
  const ts = '1970-01-01T00:00:00Z';
  const base = { created: ts, updated: ts, updated_by: 'system' as const };
  const entries = [
    { path: 'alethic.md', meta: { id: 'a-000001', kind: 'root' as const, title: 'Demo', ...base } },
    {
      path: 'plans/_section.md',
      meta: {
        id: 'sec-00001',
        kind: 'section' as const,
        title: 'Plan',
        branch: 'plan' as const,
        order: 1,
        ...base,
      },
    },
    {
      path: 'domains/_section.md',
      meta: {
        id: 'sec-00002',
        kind: 'section' as const,
        title: 'Code',
        branch: 'code' as const,
        order: 2,
        ...base,
      },
    },
    {
      path: 'plans/roadmap/_plan.md',
      meta: {
        id: 'p-000001',
        kind: 'plan' as const,
        title: 'Roadmap',
        goal: 'ship it',
        domains: [],
        ...base,
      },
    },
    {
      path: 'domains/payments/_domain.md',
      meta: {
        id: 'd-000001',
        kind: 'domain' as const,
        title: 'Payments',
        scope: ['src/**'],
        ...base,
      },
    },
  ];

  it('re-parents plans and domains onto their section, so the apex has two branches', () => {
    const index = buildIndex(entries, frozen);
    expect(index.tree['a-000001']).toEqual(['sec-00001', 'sec-00002']); // ordered Plan, then Code
    expect(index.nodes['p-000001']!.parent).toBe('sec-00001');
    expect(index.nodes['d-000001']!.parent).toBe('sec-00002');
  });

  it('never drops a node whose container is missing — it re-parents to the nearest one', () => {
    // A rule written into domains/cli/parser/ that has no _sub.md (and no _domain.md above it):
    // it must still appear under the Code section, not vanish from every subtree.
    const orphan = {
      path: 'domains/cli/parser/needs-a-subcommand.md',
      meta: {
        id: 'r-000009',
        kind: 'rule' as const,
        title: 'CLI needs a subcommand',
        status: 'ok' as const,
        provenance: 'agent' as const,
        locked: false,
        anchors: [],
        affects: [],
        tests: [],
        ...base,
      },
    };
    const index = buildIndex([...entries, orphan], frozen);
    expect(index.nodes['r-000009']!.parent).toBe('sec-00002');
    expect(index.tree['sec-00002']).toContain('r-000009');
  });

  it('leaves a map without sections attached directly to the apex (back-compat)', () => {
    const index = buildIndex(
      entries.filter((e) => !e.path.endsWith('_section.md')),
      frozen,
    );
    expect(index.nodes['p-000001']!.parent).toBe('a-000001');
    expect(index.nodes['d-000001']!.parent).toBe('a-000001');
  });
});

describe('index flags', () => {
  it('flags shallow domains/subs (decision 39)', () => {
    const index = buildIndex(toIndexEntries(loadAlethicDir(EDGE).nodes), frozen);
    expect(index.nodes['d-000002']!.flags).toContain('shallow');
    expect(index.nodes['s-000002']!.flags).toContain('shallow');
  });
});
