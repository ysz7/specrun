// Static test mapping (decision 19): which source symbols each test file imports. Filled without
// an LLM — the scanner uses this to populate a rule's `tests` from the tests that touch its anchor.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestMapping {
  test: string; // posix path
  symbols: string[]; // imported identifiers
}

const TEST_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /_test\.go$/,
];

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

/** Extract the imported identifiers from a JS/TS or Python test file (best-effort, regex-based). */
function importedSymbols(text: string): string[] {
  const names = new Set<string>();

  // JS/TS: import { A, B as C } from '...'  /  import D from '...'
  for (const m of text.matchAll(
    /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g,
  )) {
    if (m[1]) names.add(m[1]);
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) names.add(name);
      }
    }
  }
  // Python: from mod import A, B  /  import mod
  for (const m of text.matchAll(/^from\s+\S+\s+import\s+(.+)$/gm)) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && name !== '*') names.add(name);
    }
  }
  for (const m of text.matchAll(/^import\s+([A-Za-z_][\w.]*)/gm)) {
    const name = m[1]!.split('.').pop();
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Map every test file to the symbols it imports. */
export function mapTests(root: string, files: readonly string[]): TestMapping[] {
  const out: TestMapping[] = [];
  for (const rel of files) {
    if (!isTestFile(rel)) continue;
    try {
      const symbols = importedSymbols(readFileSync(join(root, rel), 'utf8'));
      if (symbols.length > 0) out.push({ test: rel, symbols });
    } catch {
      /* unreadable test file — skip */
    }
  }
  return out;
}

/** Reverse index: source symbol → the test files that import it (feeds a rule's `tests`). */
export function testsBySymbol(mappings: readonly TestMapping[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const { test, symbols } of mappings) {
    for (const s of symbols) (index[s] ??= []).push(test);
  }
  return index;
}
