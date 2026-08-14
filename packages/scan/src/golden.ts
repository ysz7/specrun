// Golden scoring (agent-prompts-spec §7): compare a produced .alethic/ map against a hand-verified
// expected map and score coverage, hallucinations (nodes anchored on trap symbols), anchor accuracy
// (named-symbol tier) and — since decision 56 — the FORM of the map: nodes must be features with
// names, not a column of sentence-shaped headings. Deterministic; the harness runs the Scanner ×3.
import { loadAlethicDir, titleNormViolation } from '@alethic/format';

export interface ExpectedRule {
  key: string;
  domain: string;
  anchors: string[]; // the anchor symbols this feature is made of; matching any of them covers it
}

export interface GoldenExpected {
  domains: string[];
  rules: ExpectedRule[];
  traps: { ruleBaitSymbols: string[]; deadCodeSymbols: string[]; unnamedSymbols?: boolean };
}

export interface ProducedRule {
  title: string;
  anchors: { symbol?: string; tier: 'symbol' | 'block' | 'file' }[];
}

export interface Thresholds {
  coverage: number;
  anchorAccuracy: number;
  /** produced nodes ÷ expected features — above this the map is a column of sentences, not features */
  fragmentation: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  coverage: 0.9,
  anchorAccuracy: 0.9,
  fragmentation: 1.5,
};

export interface ScanScore {
  coverage: number;
  matched: number;
  total: number;
  hallucinations: number;
  anchorAccuracy: number;
  /** titles that are assertions rather than names (format-spec §2, decision 56) */
  titleViolations: string[];
  /** produced ÷ expected node count: 1 is the feature-shaped map, 3 is the old granularity */
  fragmentation: number;
  missing: string[];
  pass: boolean;
}

const symbolsOf = (rule: ProducedRule): Set<string> =>
  new Set(rule.anchors.map((a) => a.symbol).filter((s): s is string => Boolean(s)));

/** Score a produced rule set against the golden expected map. */
export function scoreScan(
  produced: readonly ProducedRule[],
  expected: GoldenExpected,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ScanScore {
  const trapSymbols = new Set([
    ...expected.traps.ruleBaitSymbols,
    ...expected.traps.deadCodeSymbols,
  ]);
  const producedSets = produced.map((r) => ({ rule: r, symbols: symbolsOf(r) }));

  // coverage: each expected rule is covered by some produced rule sharing an anchor symbol.
  const missing: string[] = [];
  const matchedProduced = new Set<ProducedRule>();
  for (const exp of expected.rules) {
    const hit = producedSets.find((p) => exp.anchors.some((a) => p.symbols.has(a)));
    if (hit) matchedProduced.add(hit.rule);
    else missing.push(exp.key);
  }
  const matched = expected.rules.length - missing.length;
  const coverage = expected.rules.length === 0 ? 1 : matched / expected.rules.length;

  // hallucinations: produced rules anchored on a trap symbol.
  const hallucinations = producedSets.filter((p) =>
    [...p.symbols].some((s) => trapSymbols.has(s)),
  ).length;

  // anchor accuracy: matched produced rules whose anchors are named-symbol tier.
  let anchored = 0;
  for (const rule of matchedProduced) {
    if (rule.anchors.some((a) => a.tier === 'symbol' && a.symbol)) anchored += 1;
  }
  const anchorAccuracy = matchedProduced.size === 0 ? 1 : anchored / matchedProduced.size;

  // Form (decision 56): the unit is a feature. Two ways a run can cover everything and still be the
  // old map — titles that are assertions, and one node per sentence instead of one per feature.
  const titleViolations = produced
    .filter((r) => titleNormViolation(r.title) !== null)
    .map((r) => r.title);
  const fragmentation = expected.rules.length === 0 ? 0 : produced.length / expected.rules.length;

  const pass =
    coverage >= thresholds.coverage &&
    hallucinations === 0 &&
    anchorAccuracy >= thresholds.anchorAccuracy &&
    titleViolations.length === 0 &&
    fragmentation <= thresholds.fragmentation;
  return {
    coverage,
    matched,
    total: expected.rules.length,
    hallucinations,
    anchorAccuracy,
    titleViolations,
    fragmentation,
    missing,
    pass,
  };
}

/** Load the produced rules from a scanned `.alethic/` directory. */
export function loadProducedRules(alethicDir: string): ProducedRule[] {
  const { nodes } = loadAlethicDir(alethicDir);
  return nodes
    .filter((n) => n.meta?.kind === 'rule')
    .map((n) => {
      const anchors = (n.meta as { anchors?: { symbol?: string }[] }).anchors ?? [];
      return {
        title: n.meta!.title,
        anchors: anchors.map((a) => ({
          ...(a.symbol ? { symbol: a.symbol } : {}),
          tier: (a.symbol ? 'symbol' : 'file') as 'symbol' | 'file',
        })),
      };
    });
}
