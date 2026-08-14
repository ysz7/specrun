import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex, loadAlethicDir, toIndexEntries } from '@alethic/format';
import type { AtlasSnapshot } from '../entities/node';
import { ancestorsOf, branchOf, buildVm, childrenOf, snapshotNode, statementOf } from './viewmodel';
import { searchNodes } from './search';

const ACME = join(process.cwd(), 'fixtures/acme-commerce/.alethic');

function acmeSnapshot(): AtlasSnapshot {
  const { nodes } = loadAlethicDir(ACME);
  const index = buildIndex(toIndexEntries(nodes), () => '1970-01-01T00:00:00Z');
  return {
    root: 'fixtures/acme-commerce',
    index,
    nodes: nodes.map((n) => ({ path: n.path, meta: n.meta, body: n.body, conflict: n.conflict })),
  };
}

describe('buildVm', () => {
  const vm = buildVm(acmeSnapshot());

  it('finds the project apex and its domains', () => {
    expect(vm.projectTitle).toBe('Acme Commerce');
    const code = childrenOf(vm, vm.projectId).find((n) => n.title === 'Code')!;
    const domains = childrenOf(vm, code.id).filter((n) => n.kind === 'domain');
    expect(domains.map((d) => d.title)).toEqual(
      expect.arrayContaining(['Payments', 'Auth', 'Orders']),
    );
  });

  it('tells the Plan branch from the Code branch (decision 55)', () => {
    const branches = childrenOf(vm, vm.projectId);
    const code = branches.find((n) => n.title === 'Code')!;
    const plan = branches.find((n) => n.title === 'Plan')!;
    expect(branchOf(code)).toBe('code');
    expect(branchOf(plan)).toBe('plan');
    // and it holds all the way down each branch
    expect(childrenOf(vm, code.id).every((n) => branchOf(n) === 'code')).toBe(true);
    expect(childrenOf(vm, plan.id).every((n) => branchOf(n) === 'plan')).toBe(true);
    expect(branchOf(vm.byId.get(vm.projectId)!)).toBeNull(); // the apex is neither
  });

  it('exposes rollups and node bodies', () => {
    expect(vm.byId.get(vm.projectId)?.rollup?.worst).toBe('drift');
    const rule = snapshotNode(vm, 'r-000001');
    expect(rule?.meta?.title).toBe('Discounting an order');
    expect(rule?.body).toContain('before tax');
    expect(rule?.body).toContain('## Invariants'); // a feature body, not a lone sentence
  });
});

// Phase 5 / decision 56: domains are no longer two levels deep. A feature that filled up became a
// layer, so the view-model has to walk any depth — and "back" can no longer mean only "back to the
// project", which is what the breadcrumbs render.
describe('depth: paths of any length', () => {
  const ts = '1970-01-01T00:00:00Z';
  const base = { created: ts, updated: ts, updated_by: 'scanner' as const };
  const container = (path: string, id: string, title: string, kind: 'domain' | 'sub') => ({
    path,
    meta:
      kind === 'domain'
        ? { id, kind, title, scope: ['src/**'], ...base }
        : { id, kind, title, ...base },
    body: `What ${title} is about.`,
    conflict: false,
  });
  const deepSnapshot = (): AtlasSnapshot => {
    const nodes = [
      {
        path: 'alethic.md',
        meta: { id: 'a-1', kind: 'root' as const, title: 'Demo', ...base },
        body: 'Apex.',
        conflict: false,
      },
      {
        path: 'domains/_section.md',
        meta: {
          id: 'sec-2',
          kind: 'section' as const,
          title: 'Code',
          branch: 'code' as const,
          order: 2,
          ...base,
        },
        body: 'Code.',
        conflict: false,
      },
      container('domains/cli/_domain.md', 'd-1', 'CLI', 'domain'),
      container('domains/cli/commands/_sub.md', 's-1', 'Commands', 'sub'),
      container('domains/cli/commands/adding-a-task/_sub.md', 'r-1', 'Adding a task', 'sub'),
      {
        path: 'domains/cli/commands/adding-a-task/due-dates.md',
        meta: {
          id: 'r-2',
          kind: 'rule' as const,
          title: 'Due dates',
          status: 'ok' as const,
          provenance: 'agent' as const,
          locked: false,
          anchors: [],
          affects: [],
          tests: [],
          ...base,
        },
        body: 'A due date can be given when a task is added.',
        conflict: false,
      },
    ];
    return {
      root: '/tmp/demo',
      index: buildIndex(
        nodes.map((n) => ({ path: n.path, meta: n.meta })),
        () => ts,
      ),
      nodes,
    };
  };

  it('parents a four-level branch and walks it back to the apex', () => {
    const vm = buildVm(deepSnapshot());
    expect(vm.byId.get('r-2')!.parent).toBe('r-1'); // the promoted feature is its container
    expect(childrenOf(vm, 'r-1').map((n) => n.title)).toEqual(['Due dates']);
    expect(ancestorsOf(vm, 'r-1').map((n) => n.title)).toEqual(['Demo', 'Code', 'CLI', 'Commands']);
    expect(ancestorsOf(vm, vm.projectId)).toEqual([]);
  });

  it('exposes each container’s own statement — the roof of a layer asserts', () => {
    const vm = buildVm(deepSnapshot());
    expect(statementOf(vm, 'r-1')).toBe('What Adding a task is about.');
    expect(statementOf(vm, 'a-1')).toBe('Apex.');
  });
});

describe('searchNodes (Ctrl+K)', () => {
  const vm = buildVm(acmeSnapshot());

  it('finds a rule by a title term and ranks title matches first', () => {
    const hits = searchNodes(vm, 'discount');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title.toLowerCase()).toContain('discount');
  });

  it('matches body text too', () => {
    const hits = searchNodes(vm, 'idempotent');
    expect(hits.some((h) => h.id === 'r-000006')).toBe(true);
  });

  it('returns nothing for a miss', () => {
    expect(searchNodes(vm, 'zzzznomatch')).toEqual([]);
  });
});
