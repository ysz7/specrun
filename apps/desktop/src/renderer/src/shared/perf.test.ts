// Cold-open performance budget (Plan Phase 3 task 1, DoD): building the derived index and the
// pyramid view-model for a 1000-node map must stay well under a second, since that is the work
// between "open folder" and first paint (see also atlas.service.perf.test.ts, which times the
// real-disk read that feeds this). The re-root suite below (Plan Phase 3 task 2) guards the other
// half: Pyramid.tsx never touches more than the current apex's children and one focused branch, so
// its per-re-root cost is bounded by fan-out, not by total map size — this times that bounded work
// against a 350-node map as a frame-budget proxy for "no dropped frames while re-rooting".
import { describe, expect, it } from 'vitest';
import { buildIndex, type IndexEntry, type NodeMeta } from '@alethic/format';
import type { AtlasSnapshot } from '../entities/node';
import { ancestorsOf, buildVm, childrenOf, driftCount, statementOf } from './viewmodel';
import { visualFor } from './status';
import { searchNodes } from './search';

const TS = '2026-01-01T00:00:00Z';
const stamp = { created: TS, updated: TS, updated_by: 'scanner' as const };

/** Synthesize a realistic 1000-node map: 1 root, 20 domains, 60 subs, ~919 rules. */
function bigMap(target = 1000): IndexEntry[] {
  const entries: IndexEntry[] = [];
  entries.push({
    path: 'alethic.md',
    meta: { id: 'root-000000', kind: 'root', title: 'Big Project', ...stamp } as NodeMeta,
  });
  const domains = 20;
  const subsPer = 3;
  for (let d = 0; d < domains; d++) {
    entries.push({
      path: `domains/d${d}/_domain.md`,
      meta: {
        id: `domain-${d.toString().padStart(6, '0')}`,
        kind: 'domain',
        title: `Domain ${d}`,
        scope: [`src/d${d}/**`],
        ...stamp,
      } as NodeMeta,
    });
    for (let s = 0; s < subsPer; s++) {
      entries.push({
        path: `domains/d${d}/s${s}/_sub.md`,
        meta: {
          id: `sub-${d}${s}`.padEnd(10, '0'),
          kind: 'sub',
          title: `Sub ${d}.${s}`,
          ...stamp,
        } as NodeMeta,
      });
    }
  }
  let r = 0;
  outer: for (let d = 0; d < domains; d++) {
    for (let s = 0; s < subsPer; s++) {
      for (let k = 0; k < 20; k++) {
        if (entries.length >= target) break outer;
        const id = `r-${(r++).toString().padStart(6, '0')}`;
        entries.push({
          path: `domains/d${d}/s${s}/${id}.md`,
          meta: {
            id,
            kind: 'rule',
            title: `Rule ${d}.${s}.${k} does something specific`,
            status: 'ok',
            provenance: 'agent',
            anchors: [{ file: `src/d${d}/s${s}/file${k}.ts`, symbol: `fn${k}` }],
            affects: r > 1 ? [`r-${(r - 2).toString().padStart(6, '0')}`] : [],
            ...stamp,
          } as NodeMeta,
        });
      }
    }
  }
  return entries;
}

describe('cold-open performance', () => {
  it('builds the index + view-model for 1000 nodes in under a second', () => {
    const entries = bigMap(1000);
    expect(entries.length).toBe(1000);

    const t0 = performance.now();
    const index = buildIndex(entries, () => TS);
    const snapshot: AtlasSnapshot = { root: '/big', index, nodes: [] };
    const vm = buildVm(snapshot);
    // exercise the paths a first render touches: apex children + a search
    childrenOf(vm, vm.projectId);
    searchNodes(vm, 'specific');
    const elapsed = performance.now() - t0;

    console.log(
      `  index + view-model (in-memory, ${entries.length} nodes): ${elapsed.toFixed(1)}ms`,
    );
    expect(vm.byId.size).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('pyramid re-root performance', () => {
  it('re-roots into a populated branch of a 350-node map inside one 60fps frame', () => {
    const entries = bigMap(350);
    const index = buildIndex(entries, () => TS);
    const snapshot: AtlasSnapshot = { root: '/big350', index, nodes: [] };
    const vm = buildVm(snapshot);

    const domain = childrenOf(vm, vm.projectId)[0]!;
    const sub = childrenOf(vm, domain.id)[0]!;

    // The exact work a re-root triggers in Pyramid.tsx: recompute the context row (apex's
    // children), the newly focused branch, the breadcrumb, and the per-card visuals — nothing
    // here scans the whole map, so cost tracks fan-out, not the 350-node total.
    const t0 = performance.now();
    const rootChildren = childrenOf(vm, vm.projectId);
    const branch = childrenOf(vm, sub.id);
    const ancestors = ancestorsOf(vm, sub.id);
    for (const n of [...rootChildren, ...branch]) {
      driftCount(n);
      statementOf(vm, n.id);
      visualFor(n.status ?? n.rollup?.worst, n.flags);
    }
    const elapsed = performance.now() - t0;

    const visible = rootChildren.length + branch.length;
    console.log(
      `  re-root computation (350-node map, ${visible} visible cards, depth ${ancestors.length}): ${elapsed.toFixed(2)}ms`,
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(16.7); // one 60fps frame
  });
});
