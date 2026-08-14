import { describe, expect, it } from 'vitest';
import { anchorFor } from './anchors/index.js';
import { checkDrift, DEGRADATION_THRESHOLD, describeDrift } from './drift.js';
import type { LoadedNode } from './load.js';
import type { Anchor, RuleMeta } from './schema.js';

const TS = '2026-07-22T00:00:00Z';

async function anchor(file: string, source: string, symbol: string): Promise<Anchor> {
  const a = await anchorFor(file, source, symbol);
  if (!a) throw new Error(`no anchor for ${symbol}`);
  return a;
}

function ruleNode(path: string, id: string, anchors: Anchor[], body = 'statement'): LoadedNode {
  const meta: RuleMeta = {
    id,
    kind: 'rule',
    title: 'A rule',
    status: 'ok',
    provenance: 'agent',
    locked: false,
    anchors,
    affects: [],
    tests: [],
    created: TS,
    updated: TS,
  };
  return { path, meta, body, conflict: false };
}

const FILE = 'src/payments/discounts.ts';
const ORIGINAL = `export function applyDiscounts(order: Order): number {
  // applies discounts
  const d = order.subtotal * 0.1;
  return order.subtotal - d;
}

export function computeTax(amount: number): number {
  return amount * 0.2;
}`;

describe('checkDrift (TypeScript)', () => {
  it('reports unchanged when nothing in a changed file touches the symbol', async () => {
    const node = ruleNode('domains/payments/pricing/discount.md', 'r-000001', [
      await anchor(FILE, ORIGINAL, 'applyDiscounts'),
    ]);
    // computeTax changed, applyDiscounts untouched → no drift on this rule
    const edited = ORIGINAL.replace('amount * 0.2', 'amount * 0.25');
    const report = await checkDrift([node], new Map([[FILE, edited]]));
    expect(report.stale).toEqual([]);
    expect(report.rules).toEqual([]);
  });

  it('marks a rule stale when its anchored logic changes', async () => {
    const node = ruleNode('domains/payments/pricing/discount.md', 'r-000001', [
      await anchor(FILE, ORIGINAL, 'applyDiscounts'),
    ]);
    const edited = ORIGINAL.replace('* 0.1', '* 0.2'); // behaviour moved
    const report = await checkDrift([node], new Map([[FILE, edited]]));
    expect(report.stale).toEqual(['r-000001']);
    expect(report.rules[0]?.worst).toBe('stale');
  });

  it('does not wake on formatting-only changes', async () => {
    const node = ruleNode('domains/payments/pricing/discount.md', 'r-000001', [
      await anchor(FILE, ORIGINAL, 'applyDiscounts'),
    ]);
    const reformatted = ORIGINAL.replace(
      'const d = order.subtotal * 0.1;',
      'const d =\n    order.subtotal * 0.1;',
    );
    const report = await checkDrift([node], new Map([[FILE, reformatted]]));
    expect(report.stale).toEqual([]);
  });

  it('flags annotations-changed (comments only) without a status change', async () => {
    const node = ruleNode('domains/payments/pricing/discount.md', 'r-000001', [
      await anchor(FILE, ORIGINAL, 'applyDiscounts'),
    ]);
    const recommented = ORIGINAL.replace('// applies discounts', '// applies the promo discount');
    expect(recommented).not.toBe(ORIGINAL);
    const report = await checkDrift([node], new Map([[FILE, recommented]]));
    expect(report.stale).toEqual([]);
    expect(report.annotationsChanged).toEqual(['r-000001']);
    expect(report.rules[0]?.worst).toBe('annotations-changed');
  });

  it('reports anchor-lost when the symbol disappears', async () => {
    const node = ruleNode('domains/payments/pricing/discount.md', 'r-000001', [
      await anchor(FILE, ORIGINAL, 'applyDiscounts'),
    ]);
    const renamed = ORIGINAL.replace('applyDiscounts', 'applyPromo');
    const report = await checkDrift([node], new Map([[FILE, renamed]]));
    expect(report.stale).toEqual(['r-000001']);
    expect(report.rules[0]?.worst).toBe('anchor-lost');
  });

  it('treats a deleted file as a lost anchor', async () => {
    const node = ruleNode('domains/payments/pricing/discount.md', 'r-000001', [
      await anchor(FILE, ORIGINAL, 'applyDiscounts'),
    ]);
    const report = await checkDrift([node], new Map([[FILE, null]]));
    expect(report.rules[0]?.worst).toBe('anchor-lost');
  });

  it('flags a domain for rescan past the degradation threshold (§5.5)', async () => {
    // Three rules, three anchors; delete the whole file → 100% lost → over threshold.
    const nodes = [
      ruleNode('domains/payments/a/r1.md', 'r-000001', [
        await anchor(FILE, ORIGINAL, 'applyDiscounts'),
      ]),
      ruleNode('domains/payments/a/r2.md', 'r-000002', [
        await anchor(FILE, ORIGINAL, 'computeTax'),
      ]),
    ];
    const report = await checkDrift(nodes, new Map([[FILE, null]]));
    expect(report.degradation['payments']?.ratio).toBeGreaterThan(DEGRADATION_THRESHOLD);
    expect(report.rescanDomains).toContain('payments');
  });
});

// A feature carries many anchors, so "something inside it changed" is a blunter signal than the
// one-assertion-per-node form gave — decision 56 took that cost deliberately and named the
// compensation. Phase 6 pays it: the check says which symbol moved and which part of the body
// describes it, and how much of the feature it found untouched.
describe('checkDrift locates the change inside the feature', () => {
  const FEATURE_BODY = [
    'Pricing turns an order into the amount a customer owes.',
    '',
    '## How it works',
    'applyDiscounts subtracts the promo share from the subtotal.',
    '',
    '## Invariants',
    '- computeTax is applied after the discount, never before',
  ].join('\n');

  it('names the moved symbol, its section, and what stayed put', async () => {
    const node = ruleNode(
      'domains/payments/pricing/pricing.md',
      'r-000001',
      [
        await anchor(FILE, ORIGINAL, 'applyDiscounts'),
        await anchor(FILE, ORIGINAL, 'computeTax'),
        { file: 'src/util/log.ts', hash: 'blake3:deadbeefdeadbeef' },
      ],
      FEATURE_BODY,
    );
    // Only computeTax moves; applyDiscounts and the log anchor are untouched.
    const edited = ORIGINAL.replace('amount * 0.2', 'amount * 0.25');
    const report = await checkDrift([node], new Map([[FILE, edited]]));

    const drift = report.rules[0]!;
    const moved = drift.checks.filter((c) => c.verdict !== 'unchanged');
    expect(moved.map((c) => c.symbol)).toEqual(['computeTax']);
    expect(moved[0]!.place).toBe('## Invariants');
    expect(drift.untouched).toBe(1); // src/util/log.ts was never in the changed set

    const sentence = describeDrift(drift);
    expect(sentence).toContain('computeTax (## Invariants)');
    expect(sentence).toContain('2 other anchors unchanged'); // applyDiscounts + the log anchor
    expect(sentence).not.toContain('applyDiscounts'); // what moved, not a re-listing of the node
  });

  it('says so plainly when the symbol is not described anywhere in the body', async () => {
    const node = ruleNode(
      'domains/payments/pricing/pricing.md',
      'r-000002',
      [await anchor(FILE, ORIGINAL, 'computeTax')],
      'Pricing turns an order into the amount a customer owes.\n\n## Invariants\n- the total is never negative',
    );
    const report = await checkDrift([node], new Map([[FILE, ORIGINAL.replace('* 0.2', '* 0.25')]]));
    expect(report.rules[0]!.checks[0]!.place).toBeUndefined();
    expect(describeDrift(report.rules[0]!)).toBe('changed: computeTax');
  });
});

const PY_FILE = 'app/auth.py';
const PY_ORIGINAL = `def create_session(user):
    # sessions live for 30 days
    return Session(user, ttl_days=30)
`;

describe('checkDrift (Python)', () => {
  it('detects a behavioural change in a python symbol', async () => {
    const node = ruleNode('domains/auth/sessions/ttl.md', 'r-000010', [
      await anchor(PY_FILE, PY_ORIGINAL, 'create_session'),
    ]);
    const edited = PY_ORIGINAL.replace('ttl_days=30', 'ttl_days=7');
    const report = await checkDrift([node], new Map([[PY_FILE, edited]]));
    expect(report.stale).toEqual(['r-000010']);
  });

  it('ignores comment-only edits in python', async () => {
    const node = ruleNode('domains/auth/sessions/ttl.md', 'r-000010', [
      await anchor(PY_FILE, PY_ORIGINAL, 'create_session'),
    ]);
    const edited = PY_ORIGINAL.replace('# sessions live for 30 days', '# 30-day sessions');
    const report = await checkDrift([node], new Map([[PY_FILE, edited]]));
    expect(report.stale).toEqual([]);
    expect(report.annotationsChanged).toEqual(['r-000010']);
  });
});
