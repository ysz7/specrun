import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProducedRules, scoreScan, type GoldenExpected, type ProducedRule } from './golden.js';

const expected: GoldenExpected = {
  domains: ['payments'],
  rules: [
    { key: 'discount-before-tax', domain: 'payments', anchors: ['applyDiscounts'] },
    { key: 'tax-on-discounted', domain: 'payments', anchors: ['computeTax'] },
    { key: 'refund-le-captured', domain: 'payments', anchors: ['processRefund'] },
  ],
  traps: { ruleBaitSymbols: ['serializeDiscount'], deadCodeSymbols: ['legacyDiscount'] },
};

const rule = (title: string, ...symbols: string[]): ProducedRule => ({
  title,
  anchors: symbols.map((symbol) => ({ symbol, tier: 'symbol' })),
});

describe('scoreScan', () => {
  it('passes on full coverage with no hallucinations', () => {
    const produced = [
      rule('Discount before tax', 'applyDiscounts', 'computeTax'),
      rule('Refund', 'processRefund'),
    ];
    const score = scoreScan(produced, expected);
    expect(score.coverage).toBe(1);
    expect(score.hallucinations).toBe(0);
    expect(score.pass).toBe(true);
  });

  it('fails when a rule is anchored on a trap symbol (hallucination)', () => {
    const produced = [
      rule('a', 'applyDiscounts', 'computeTax'),
      rule('b', 'processRefund'),
      rule('bait', 'serializeDiscount'),
    ];
    const score = scoreScan(produced, expected);
    expect(score.hallucinations).toBe(1);
    expect(score.pass).toBe(false);
  });

  it('reports missing rules and drops below the coverage threshold', () => {
    const produced = [rule('only one', 'applyDiscounts')];
    const score = scoreScan(produced, expected);
    expect(score.missing).toEqual(
      expect.arrayContaining(['tax-on-discounted', 'refund-le-captured']),
    );
    expect(score.coverage).toBeLessThan(0.9);
    expect(score.pass).toBe(false);
  });

  it('penalizes file-tier anchors on matched rules', () => {
    const produced: ProducedRule[] = [
      { title: 'a', anchors: [{ tier: 'file' }] }, // matches nothing (no symbol)
      rule('b', 'applyDiscounts'),
      rule('c', 'computeTax'),
      { title: 'd', anchors: [{ symbol: 'processRefund', tier: 'file' }] }, // matched but file-tier
    ];
    const score = scoreScan(produced, expected);
    expect(score.anchorAccuracy).toBeLessThan(1);
  });
});

describe('loadProducedRules', () => {
  it('reads rules + anchor tiers from a scanned .alethic/', () => {
    const produced = loadProducedRules(join(process.cwd(), 'fixtures/acme-commerce/.alethic'));
    expect(produced.length).toBeGreaterThanOrEqual(12); // features, not one node per sentence
    // score the acme map against a subset expected — proves the end-to-end path
    const score = scoreScan(produced, {
      domains: ['payments'],
      rules: [
        { key: 'discounting-an-order', domain: 'payments', anchors: ['applyDiscounts'] },
        { key: 'refunding-a-capture', domain: 'payments', anchors: ['processRefund'] },
      ],
      traps: { ruleBaitSymbols: [], deadCodeSymbols: [] },
    });
    expect(score.coverage).toBe(1);
    expect(score.anchorAccuracy).toBe(1);
    // the reference map is the shape decision 56 asks for: names, not assertions
    expect(score.titleViolations).toEqual([]);
  });
});

// Decision 56: a run can cover everything and still be the old map — a column of sentence-shaped
// headings. The gate scores the form too, so the golden can't drift back to per-assertion nodes.
describe('scoreScan — the form of the map (decision 56)', () => {
  it('fails a map whose titles are assertions rather than names', () => {
    const produced = [
      rule('Discount applies to the subtotal before tax is computed.', 'applyDiscounts'),
      rule('Tax is computed on the discounted subtotal.', 'computeTax'),
      rule('A refund never exceeds the captured amount.', 'processRefund'),
    ];
    const score = scoreScan(produced, expected);
    expect(score.coverage).toBe(1);
    expect(score.titleViolations).toHaveLength(3);
    expect(score.pass).toBe(false);
  });

  it('fails a map fragmented into one node per sentence', () => {
    const produced = [
      rule('Discounting an order', 'applyDiscounts'),
      rule('Zero subtotals', 'applyDiscounts'),
      rule('Discount cap', 'applyDiscounts'),
      rule('Tax base', 'computeTax'),
      rule('Tax rounding', 'computeTax'),
      rule('Refunding a capture', 'processRefund'),
      rule('Refund clamping', 'processRefund'),
    ];
    const score = scoreScan(produced, expected);
    expect(score.coverage).toBe(1);
    expect(score.fragmentation).toBeGreaterThan(2);
    expect(score.pass).toBe(false);
  });

  it('passes a feature-shaped map that covers the same code in fewer nodes', () => {
    const produced = [
      rule('Discounting an order', 'applyDiscounts', 'computeTax'),
      rule('Refunding a capture', 'processRefund'),
    ];
    const score = scoreScan(produced, expected);
    expect(score.fragmentation).toBeLessThanOrEqual(1);
    expect(score.pass).toBe(true);
  });
});
