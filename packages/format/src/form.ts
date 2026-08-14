// The form of a node (decision 56, Phase 6). The unit of the Code branch is a FEATURE — a named
// capability with a body — and everything scanned before decision 56 is a different unit: one
// breakable sentence per file, the sentence itself as the title. Both forms parse, both validate,
// and that is exactly the danger: a map holding some of each stops reading as one thought and
// nothing on screen says why. So the old form is detected deterministically (no LLM, no guessing)
// and carried into the index as a flag, which is what makes "this map is still in the old form"
// something the product says out loud instead of something the reader eventually notices.
import { parseSections } from './sections.js';
import { titleNormViolation } from './titles.js';
import type { NodeMeta } from './schema.js';

/**
 * What the audit needs of a node — structurally what the loader produces, declared here rather than
 * imported: `load.ts` computes this flag on every node it reads, so importing `LoadedNode` back
 * would make the two modules circular.
 */
export interface AuditableNode {
  path: string;
  meta: NodeMeta | null;
  body: string;
}

/** The index flag a node in the pre-decision-56 form carries. */
export const LEGACY_FLAG = 'legacy-form';

/**
 * The body `SpecStore.ensureContainers` writes for a domain/sub card it had to auto-create (a
 * feature landed under a container that did not exist yet) — a folder name standing in until a
 * real scan or a human describes it. Exported so the validator can recognise its own placeholder
 * instead of counting it as a roof that actually asserts something (format-spec §7).
 */
export const PLACEHOLDER_CONTAINER_BODY = {
  domain: 'Inferred from the code map — rescan this domain to describe it properly.',
  sub: 'Inferred from the code map.',
} as const;

/**
 * Sections that are bookkeeping rather than the feature's substance. A retired-in-place rule with
 * nothing but a `## Drift log` is still a bare assertion, so these do not count as "has a body".
 */
const BOOKKEEPING = new Set(['drift log', 'proposals']);

/**
 * Why this node is in the old form, or `null` when it is a feature. One reason, phrased for a human
 * and for the migration prompt — the same shape as {@link titleNormViolation}, which it subsumes.
 *
 * Two signals, both structural (decision 56 defines the form as *name* + *statement and sections*):
 *  1. the title is an assertion rather than a name — the loudest tell of the old granularity;
 *  2. the body has no `## ` section at all — a single sentence standing alone, which is precisely
 *     what the old unit was. Depth does not excuse it: even a shallow scan writes `## Invariants`.
 */
export function legacyFormViolation(meta: NodeMeta, body: string): string | null {
  if (meta.kind !== 'rule') return null;
  const titleIssue = titleNormViolation(meta.title);
  if (titleIssue) return titleIssue;
  const sections = parseSections(body).sections.filter(
    (s) => !BOOKKEEPING.has(s.heading.trim().toLowerCase()),
  );
  if (sections.length === 0)
    return 'body is one bare statement with no sections — a feature says what it is responsible for, how it works and what it guarantees (## How it works / ## Where it is used / ## Invariants)';
  return null;
}

/** A node still in the pre-feature form, with the reason it counts as one. */
export interface LegacyNode {
  id: string;
  path: string; // `.alethic/`-relative
  title: string;
  reason: string;
}

export interface FormAudit {
  /** Rule nodes examined. */
  rules: number;
  /** Those still in the old form. */
  legacy: LegacyNode[];
  /** Containing folder → how many of its children are still old-form, for "migrate this branch". */
  byContainer: Record<string, number>;
}

/**
 * Audit a whole map's form. Deterministic and cheap, so it can run on every load: the answer drives
 * the card marker, the Migrate action and the post-migration check that the two forms did not end
 * up living side by side after all.
 */
export function auditForm(nodes: readonly AuditableNode[]): FormAudit {
  const legacy: LegacyNode[] = [];
  const byContainer: Record<string, number> = {};
  let rules = 0;
  for (const node of nodes) {
    if (!node.meta || node.meta.kind !== 'rule') continue;
    rules += 1;
    const reason = legacyFormViolation(node.meta, node.body);
    if (!reason) continue;
    legacy.push({ id: node.meta.id, path: node.path, title: node.meta.title, reason });
    const dir = node.path.replace(/\/[^/]+$/, '');
    byContainer[dir] = (byContainer[dir] ?? 0) + 1;
  }
  return { rules, legacy, byContainer };
}
