import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkFiles } from './walk.js';
import { readManifests } from './manifests.js';
import { domainCandidates } from './domains.js';
import { isTestFile, mapTests, testsBySymbol } from './tests.js';
import { buildRepoMap } from './repo-map.js';

const ACME = join(process.cwd(), 'fixtures/acme-commerce');

describe('walkFiles', () => {
  it('lists source files and ignores .alethic/ and node_modules', () => {
    const files = walkFiles(ACME);
    expect(files).toContain('src/payments.ts');
    expect(files.some((f) => f.startsWith('.alethic/'))).toBe(false);
  });
});

describe('manifests', () => {
  it('parses npm workspaces and compose services', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scan-man-'));
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(tmp, 'docker-compose.yml'),
      'services:\n  api:\n    image: node\n  db:\n    image: postgres\n',
    );
    const manifests = readManifests(tmp, ['package.json', 'docker-compose.yml']);
    expect(manifests.find((m) => m.kind === 'npm')?.workspaces).toEqual(['packages/*']);
    expect(manifests.find((m) => m.kind === 'compose')?.units).toEqual(['api', 'db']);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('domainCandidates', () => {
  it('makes one domain per monorepo package (decision 11)', () => {
    const files = [
      'packages/format/src/index.ts',
      'packages/ipc/src/index.ts',
      'apps/desktop/src/main.ts',
    ];
    const manifests = readManifests(process.cwd(), []); // none needed; globs provided directly
    const domains = domainCandidates(files, manifests, ['packages/*', 'apps/*']);
    expect(domains.map((d) => d.slug).sort()).toEqual(['desktop', 'format', 'ipc']);
    expect(domains.find((d) => d.slug === 'format')?.scope).toEqual(['packages/format/**']);
  });

  it('falls back to src/ subdirectories for a plain repo', () => {
    const files = ['src/payments/index.ts', 'src/auth/login.ts', 'README.md'];
    const domains = domainCandidates(files, [], []);
    expect(domains.map((d) => d.slug).sort()).toEqual(['auth', 'payments']);
  });
});

describe('tests mapping (decision 19)', () => {
  it('detects test files and the symbols they import', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'scan-test-'));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(
      join(tmp, 'src/pricing.test.ts'),
      "import { applyDiscounts, computeTax } from './pricing';\n",
    );
    writeFileSync(join(tmp, 'src/refund_test.py'), 'from svc.refund import process_refund\n');
    expect(isTestFile('src/pricing.test.ts')).toBe(true);
    const mappings = mapTests(tmp, ['src/pricing.test.ts', 'src/refund_test.py']);
    expect(mappings.find((m) => m.test.endsWith('pricing.test.ts'))?.symbols).toEqual(
      expect.arrayContaining(['applyDiscounts', 'computeTax']),
    );
    const index = testsBySymbol(mappings);
    expect(index['applyDiscounts']).toContain('src/pricing.test.ts');
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('buildRepoMap', () => {
  it('produces files with tree-sitter symbols and detects manifests', async () => {
    const map = await buildRepoMap(ACME);
    const payments = map.files.find((f) => f.path === 'src/payments.ts');
    expect(payments?.lang).toBe('typescript');
    expect(payments?.symbols).toEqual(expect.arrayContaining(['applyDiscounts', 'computeTax']));
  });
});
