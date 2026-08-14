import { describe, expect, it } from 'vitest';
import { languageForFile, parseTree } from './engine.js';
import { docHash, structuralHash } from './hash.js';
import { anchorFor, extractSymbols, findSymbol } from './extract.js';

async function tsHash(src: string): Promise<string> {
  return structuralHash((await parseTree('typescript', src)).rootNode);
}
async function pyHash(src: string): Promise<string> {
  return structuralHash((await parseTree('python', src)).rootNode);
}

describe('structural hash (format-spec §5.2)', () => {
  it('is stable across formatting and comment changes (TypeScript)', async () => {
    const a = `function applyDiscounts(order) {
      // apply percentage first
      return order.subtotal * (1 - order.discount);
    }`;
    const b = `function applyDiscounts(order){return order.subtotal*(1-order.discount);}`;
    expect(await tsHash(a)).toBe(await tsHash(b));
  });

  it('changes when logic changes (TypeScript)', async () => {
    const a = `function f(o){return o.subtotal;}`;
    const c = `function f(o){return o.subtotal - o.tax;}`;
    expect(await tsHash(a)).not.toBe(await tsHash(c));
  });

  it('changes when an identifier is renamed (rename is a real change)', async () => {
    expect(await tsHash(`function f(a){return a+1;}`)).not.toBe(
      await tsHash(`function f(b){return b+1;}`),
    );
  });

  it('is stable across formatting/comments and sensitive to logic (Python)', async () => {
    const a = `def refund(amount):\n    # cap at captured\n    return min(amount, captured)`;
    const b = `def refund(amount):\n    return min(amount,captured)`;
    const c = `def refund(amount):\n    return max(amount, captured)`;
    expect(await pyHash(a)).toBe(await pyHash(b));
    expect(await pyHash(a)).not.toBe(await pyHash(c));
  });

  it('has the on-disk hash shape', async () => {
    expect(await tsHash('const x = 1;')).toMatch(/^blake3:[0-9a-f]{16}$/);
  });
});

describe('docHash (format-spec §5.4)', () => {
  it('captures comments and is undefined when there are none', async () => {
    const withDoc = (await parseTree('typescript', `function f(){ /* note */ return 1; }`))
      .rootNode;
    const without = (await parseTree('typescript', `function f(){ return 1; }`)).rootNode;
    expect(docHash(withDoc)).toMatch(/^blake3:[0-9a-f]{16}$/);
    expect(docHash(without)).toBeUndefined();
  });
});

describe('symbol extraction & tiers (format-spec §5.1)', () => {
  it('extracts TS symbols with class-qualified method FQNs', async () => {
    const syms = await extractSymbols(
      'svc.ts',
      `export class P { compute(o){return o;} }\nexport const f = (x) => x;`,
    );
    const names = syms.map((s) => s.symbol);
    expect(names).toContain('P');
    expect(names).toContain('P.compute');
    expect(names).toContain('f');
    expect(syms.every((s) => s.tier === 'symbol')).toBe(true);
  });

  it('extracts Python class/method FQNs', async () => {
    const syms = await extractSymbols(
      'svc.py',
      `class R:\n    def process(self, a):\n        return a\n\ndef top():\n    return 1`,
    );
    expect(syms.map((s) => s.symbol)).toEqual(expect.arrayContaining(['R', 'R.process', 'top']));
  });

  it('uses YAML key paths as symbols', async () => {
    const syms = await extractSymbols(
      'docker-compose.yml',
      'services:\n  api:\n    image: node:24\n',
    );
    expect(syms.map((s) => s.symbol)).toEqual(
      expect.arrayContaining(['services', 'services.api', 'services.api.image']),
    );
  });

  it('falls back to a file-tier anchor for unknown formats', async () => {
    const syms = await extractSymbols('data.unknownext', 'a\nb\nc');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.tier).toBe('file');
    expect(syms[0]!.symbol).toBeUndefined();
  });
});

describe('languageForFile', () => {
  it('maps extensions to grammars and returns null for the unknown', () => {
    expect(languageForFile('a.ts')).toBe('typescript');
    expect(languageForFile('a.py')).toBe('python');
    expect(languageForFile('docker-compose.yml')).toBe('yaml');
    expect(languageForFile('README')).toBeNull();
    expect(languageForFile('data.unknownext')).toBeNull();
  });
});

describe('findSymbol & anchorFor', () => {
  const src = `export function applyDiscounts(o){ /* note */ return o.subtotal; }`;

  it('findSymbol locates a symbol by FQN', async () => {
    const found = await findSymbol('p.ts', src, 'applyDiscounts');
    expect(found?.symbol).toBe('applyDiscounts');
    expect(await findSymbol('p.ts', src, 'nope')).toBeUndefined();
  });

  it('anchorFor builds an on-disk anchor for a named symbol', async () => {
    const anchor = await anchorFor('p.ts', src, 'applyDiscounts');
    expect(anchor?.file).toBe('p.ts');
    expect(anchor?.symbol).toBe('applyDiscounts');
    expect(anchor?.hash).toMatch(/^blake3:[0-9a-f]{16}$/);
    expect(anchor?.dochash).toMatch(/^blake3:[0-9a-f]{16}$/);
  });

  it('anchorFor returns a file-tier anchor when no symbol is requested for an unknown format', async () => {
    const anchor = await anchorFor('data.unknownext', 'x\ny');
    expect(anchor?.symbol).toBeUndefined();
    expect(anchor?.hash).toMatch(/^blake3:[0-9a-f]{16}$/);
  });
});
