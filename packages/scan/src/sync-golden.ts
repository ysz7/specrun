// Sync-case golden scoring (agent-prompts-spec §7.4): pairs of (rule, old-code, new-code,
// expected-verdict), 5+ per verdict. The Sync agent's job is to return exactly one of three
// verdicts; the hard threshold is 100% correct on the cosmetic-vs-behaviour trap cases. Running
// the agent needs live Claude (done by scripts/golden-scan.mjs); the scoring + fixture shape are
// deterministic and unit-tested here.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SYNC_VERDICTS = ['cosmetic', 'behavior-changed', 'rule-outdated'] as const;
export type SyncVerdict = (typeof SYNC_VERDICTS)[number];

export interface SyncCase {
  key: string;
  verdict: SyncVerdict; // the expected verdict
  rule: string; // the rule's statement (what the map claims)
  file: string; // anchor file (for language detection)
  symbol: string; // anchored symbol
  old: string; // the anchored code before the change
  new: string; // the anchored code after the change
  /** A case whose cosmetic-vs-behaviour distinction must never be missed (100% threshold). */
  trap?: boolean;
}

export interface SyncScore {
  total: number;
  correct: number;
  accuracy: number;
  trapTotal: number;
  trapCorrect: number;
  trapPass: boolean; // 100% on trap cases
  misses: string[];
  pass: boolean;
}

/** Load every `*.json` sync case from a directory. */
export function loadSyncCases(dir: string): SyncCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as SyncCase)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Score the agent's verdicts (keyed by case key) against the expected cases. */
export function scoreSyncCases(
  cases: readonly SyncCase[],
  actual: ReadonlyMap<string, SyncVerdict>,
): SyncScore {
  let correct = 0;
  let trapTotal = 0;
  let trapCorrect = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const got = actual.get(c.key);
    const ok = got === c.verdict;
    if (ok) correct += 1;
    else misses.push(`${c.key}: expected ${c.verdict}, got ${got ?? '∅'}`);
    if (c.trap) {
      trapTotal += 1;
      if (ok) trapCorrect += 1;
    }
  }
  const total = cases.length;
  const accuracy = total === 0 ? 1 : correct / total;
  const trapPass = trapTotal === 0 ? true : trapCorrect === trapTotal;
  return {
    total,
    correct,
    accuracy,
    trapTotal,
    trapCorrect,
    trapPass,
    misses,
    // hard gate is 100% on traps (§7.4); overall accuracy is a calibration signal
    pass: trapPass,
  };
}
