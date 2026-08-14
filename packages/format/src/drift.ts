// The drift trigger (format-spec §5.3–5.5): a deterministic, LLM-free check run by the `system`
// writer. Given the source of the files that changed, it recomputes each anchor's structural and
// doc hash and classifies every rule as unchanged / stale / annotations-changed / anchor-lost.
// Only when this layer says "the logic actually moved" do we spend a token on the Sync agent.
import { extractSymbols, fileHash, type ExtractedSymbol } from './anchors/index.js';
import { describePlace, locateInBody } from './sections.js';
import type { LoadedNode } from './load.js';
import type { Anchor, NodeMeta, RuleMeta } from './schema.js';

/** Per-anchor verdict, from cheapest to most severe. */
export type AnchorVerdict = 'unchanged' | 'annotations-changed' | 'stale' | 'anchor-lost';

const SEVERITY: Record<AnchorVerdict, number> = {
  unchanged: 0,
  'annotations-changed': 1,
  stale: 2,
  'anchor-lost': 3,
};

export interface AnchorCheck {
  file: string;
  symbol?: string;
  verdict: AnchorVerdict;
  newHash?: string; // recomputed structural hash (present unless anchor-lost)
  newDochash?: string;
  newSpan?: [number, number];
  /** Which part of the feature's body speaks about this symbol (`## Invariants`, …) — see below. */
  place?: string;
}

export interface RuleDrift {
  id: string;
  path: string; // `.alethic/`-relative rule path
  domain: string; // owning domain slug (from the path)
  worst: AnchorVerdict;
  checks: AnchorCheck[];
  /**
   * The anchors of this rule whose file did NOT change. A feature is many symbols, so naming what
   * moved is only half the signal — what demonstrably did not move is the other half, and it is
   * what keeps the verdict from re-litigating the whole node (decision 56's accepted cost).
   */
  untouched: number;
}

export interface DomainDegradation {
  lost: number; // anchors whose symbol vanished
  total: number; // all anchors of the domain's rules
  ratio: number;
  overThreshold: boolean;
}

export interface DriftReport {
  /** Every rule touched by a changed file, with its worst verdict. */
  rules: RuleDrift[];
  /** Rule ids that must move to `stale` (structural change or a lost anchor). */
  stale: string[];
  /** Rule ids whose only change was comments — a flag, never a status (§5.4). */
  annotationsChanged: string[];
  /** Per-domain loss ratio; domains over the threshold get a whole-domain rescan (§5.5). */
  degradation: Record<string, DomainDegradation>;
  /** Domain slugs whose loss exceeded the threshold — "Rescan domain". */
  rescanDomains: string[];
}

/** > 30% of a domain's anchors lost in one sync → don't guess rule-by-rule, rescan (§5.5). */
export const DEGRADATION_THRESHOLD = 0.3;

const isRuleNode = (n: LoadedNode): n is LoadedNode & { meta: RuleMeta } => n.meta?.kind === 'rule';

/** The owning domain slug of a rule at `domains/<domain>/<sub>/<rule>.md`. */
function domainOf(path: string): string {
  const parts = path.split('/');
  return parts[0] === 'domains' ? (parts[1] ?? '') : '';
}

function worstOf(checks: readonly AnchorCheck[]): AnchorVerdict {
  let worst: AnchorVerdict = 'unchanged';
  for (const c of checks) if (SEVERITY[c.verdict] > SEVERITY[worst]) worst = c.verdict;
  return worst;
}

/** Classify one anchor against a freshly-extracted symbol table (or a whole-file hash). */
function checkAnchor(anchor: Anchor, symbols: ExtractedSymbol[], source: string): AnchorCheck {
  const base: Omit<AnchorCheck, 'verdict'> = {
    file: anchor.file,
    ...(anchor.symbol ? { symbol: anchor.symbol } : {}),
  };

  // File-tier anchor: compare the whole-file hash, nothing to look up.
  if (anchor.symbol === undefined) {
    const newHash = fileHash(source);
    return { ...base, verdict: newHash === anchor.hash ? 'unchanged' : 'stale', newHash };
  }

  const found = symbols.find((s) => s.symbol === anchor.symbol);
  if (!found) return { ...base, verdict: 'anchor-lost' };

  const out: AnchorCheck = {
    ...base,
    verdict: 'unchanged',
    newHash: found.hash,
    ...(found.dochash !== undefined ? { newDochash: found.dochash } : {}),
    newSpan: found.span,
  };
  if (found.hash !== anchor.hash) return { ...out, verdict: 'stale' };
  // Structure identical, comments moved: a flag, not a status (§5.4).
  if (anchor.dochash !== undefined && found.dochash !== anchor.dochash) {
    return { ...out, verdict: 'annotations-changed' };
  }
  return out;
}

const anchorsOf = (meta: NodeMeta): Anchor[] =>
  meta.kind === 'rule' || meta.kind === 'plan-step' ? meta.anchors : [];

/**
 * Run the drift check over the set of files that changed. `changed` maps a repo-relative path (as
 * stored on anchors) to its current source, or `null` when the file was deleted. Files absent from
 * the map are assumed untouched, so their rules are never re-hashed — that is the whole economy.
 */
export async function checkDrift(
  nodes: readonly LoadedNode[],
  changed: ReadonlyMap<string, string | null>,
): Promise<DriftReport> {
  const rules = nodes.filter(isRuleNode);

  // Extract each changed file's symbols once (null = deleted → every anchor is lost).
  const symbolsByFile = new Map<string, ExtractedSymbol[]>();
  for (const [file, source] of changed) {
    if (source === null) continue;
    symbolsByFile.set(file, await extractSymbols(file, source));
  }

  const drifts: RuleDrift[] = [];
  for (const node of rules) {
    const anchors = anchorsOf(node.meta);
    // Only re-check anchors whose file changed; others stay as they were.
    const touched = anchors.filter((a) => changed.has(a.file));
    if (touched.length === 0) continue;

    const checks = touched.map((a) => {
      const source = changed.get(a.file);
      const check =
        source === null || source === undefined
          ? {
              file: a.file,
              ...(a.symbol ? { symbol: a.symbol } : {}),
              verdict: 'anchor-lost' as const,
            }
          : checkAnchor(a, symbolsByFile.get(a.file) ?? [], source);
      // Locate the moved symbol inside the feature's own body (decision 56's compensation): the
      // section that names it is the part of the feature that changed, so the verdict can say
      // "the ## Invariants of «Adding a task» moved" instead of "something in it did".
      const place = a.symbol ? locateInBody(node.body, a.symbol) : null;
      return place ? { ...check, place: describePlace(place) } : check;
    });

    const worst = worstOf(checks);
    if (worst === 'unchanged') continue;
    drifts.push({
      id: node.meta.id,
      path: node.path,
      domain: domainOf(node.path),
      worst,
      checks,
      untouched: anchors.length - touched.length,
    });
  }

  // Degradation ratio per domain: lost anchors over every anchor the domain owns (§5.5).
  const totalByDomain = new Map<string, number>();
  for (const node of rules) {
    const d = domainOf(node.path);
    totalByDomain.set(d, (totalByDomain.get(d) ?? 0) + anchorsOf(node.meta).length);
  }
  const lostByDomain = new Map<string, number>();
  for (const drift of drifts) {
    const lost = drift.checks.filter((c) => c.verdict === 'anchor-lost').length;
    if (lost > 0) lostByDomain.set(drift.domain, (lostByDomain.get(drift.domain) ?? 0) + lost);
  }

  const degradation: Record<string, DomainDegradation> = {};
  const rescanDomains: string[] = [];
  for (const [domain, lost] of lostByDomain) {
    const total = totalByDomain.get(domain) ?? lost;
    const ratio = total === 0 ? 0 : lost / total;
    const overThreshold = ratio > DEGRADATION_THRESHOLD;
    degradation[domain] = { lost, total, ratio, overThreshold };
    if (overThreshold) rescanDomains.push(domain);
  }

  const stale = drifts
    .filter((d) => d.worst === 'stale' || d.worst === 'anchor-lost')
    .map((d) => d.id);
  const annotationsChanged = drifts
    .filter((d) => d.worst === 'annotations-changed')
    .map((d) => d.id);

  return { rules: drifts, stale, annotationsChanged, degradation, rescanDomains };
}

/**
 * The drift verdict as a sentence about a *place inside the feature*, not about the feature as a
 * whole (Phase 6, decision 56's accepted cost). One line, deterministic: which symbols moved, where
 * in the body they are described, and how much of the feature the check found untouched. It goes to
 * the Sync agent as the scope of its judgement and to the user as the progress line, so the two are
 * never telling different stories about the same rule.
 */
export function describeDrift(drift: RuleDrift): string {
  const moved = drift.checks.filter((c) => c.verdict !== 'unchanged');
  const lost = moved.filter((c) => c.verdict === 'anchor-lost');
  const named = moved.map((c) => `${c.symbol ?? c.file}${c.place ? ` (${c.place})` : ''}`);
  const parts: string[] = [];
  if (named.length > 0) parts.push(`changed: ${named.join(', ')}`);
  if (lost.length > 0)
    parts.push(`${lost.length} anchor${lost.length === 1 ? '' : 's'} gone from the code`);
  const steady = drift.untouched + drift.checks.length - moved.length;
  if (steady > 0) parts.push(`${steady} other anchor${steady === 1 ? '' : 's'} unchanged`);
  return parts.join(' · ');
}
