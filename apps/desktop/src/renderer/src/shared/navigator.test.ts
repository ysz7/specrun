import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex, loadAlethicDir, toIndexEntries } from '@alethic/format';
import type { AtlasSnapshot } from '../entities/node';
import { buildVm } from './viewmodel';
import {
  buildNavigatorContext,
  citedNodeIds,
  detectPlanProposal,
  segmentMessage,
} from './navigator';

const ACME = join(process.cwd(), 'fixtures/acme-commerce/.alethic');

function acmeVm(): ReturnType<typeof buildVm> {
  const { nodes } = loadAlethicDir(ACME);
  const index = buildIndex(toIndexEntries(nodes), () => '1970-01-01T00:00:00Z');
  const snapshot: AtlasSnapshot = {
    root: 'fixtures/acme-commerce',
    index,
    nodes: nodes.map((n) => ({ path: n.path, meta: n.meta, body: n.body, conflict: n.conflict })),
  };
  return buildVm(snapshot);
}

describe('buildNavigatorContext (decision 20)', () => {
  const vm = acmeVm();

  it('summarizes domains one line each and names the current view', () => {
    const firstDomain = [...vm.byId.values()].find((n) => n.kind === 'domain')!;
    const ctx = buildNavigatorContext(vm, {
      apexId: vm.projectId,
      focusId: firstDomain.id,
      expandedId: 'r-000001',
    });
    expect(ctx).toContain('[MAP CONTEXT]');
    expect(ctx).toContain('Domains:');
    expect(ctx).toContain(firstDomain.title);
    expect(ctx).toContain(`Focused branch: ${firstDomain.title}`);
    expect(ctx).toContain('Open node:');
    expect(ctx).toContain('r-000001');
  });

  it('stays light — one line per domain, not the whole tree', () => {
    const ctx = buildNavigatorContext(vm, {
      apexId: vm.projectId,
      focusId: null,
      expandedId: null,
    });
    const domains = [...vm.byId.values()].filter((n) => n.kind === 'domain');
    const domainLines = ctx.split('\n').filter((l) => l.startsWith('- '));
    expect(domainLines).toHaveLength(domains.length);
  });
});

describe('citedNodeIds / segmentMessage', () => {
  const vm = acmeVm();

  it('extracts only ids that exist in the map, first-seen order, deduped', () => {
    const text = 'See r-000001 and r-000002, and again r-000001; ignore r-ffffff.';
    expect(citedNodeIds(text, vm)).toEqual(['r-000001', 'r-000002']);
  });

  it('segments a message into text and clickable node-id parts', () => {
    const segs = segmentMessage('lives in r-000001 today', vm);
    expect(segs.find((s) => s.nodeId === 'r-000001')).toBeTruthy();
    expect(segs.map((s) => s.text).join('')).toBe('lives in r-000001 today');
  });

  it('leaves a message with no valid ids as a single plain segment', () => {
    const segs = segmentMessage('no ids here', vm);
    expect(segs).toEqual([{ text: 'no ids here' }]);
  });
});

describe('detectPlanProposal (decision 21 — proposal only)', () => {
  it('detects and strips the [[PLAN]] marker', () => {
    const { isPlan, clean } = detectPlanProposal('1. step\n2. step\n[[PLAN]]');
    expect(isPlan).toBe(true);
    expect(clean).toBe('1. step\n2. step');
  });

  it('a plain answer is not a plan proposal', () => {
    const { isPlan, clean } = detectPlanProposal('The rule is r-000001.');
    expect(isPlan).toBe(false);
    expect(clean).toBe('The rule is r-000001.');
  });
});
