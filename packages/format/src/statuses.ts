// The status machine — the single gate through which statuses may change (format-spec §1.2).
// Humans never set statuses directly; they run processes and the writer roles below move the node.
import type { Status, Writer } from './schema.js';

/** One legal edge in the status graph: `from → to`, permitted only for writer `by`. */
export interface Transition {
  from: Status;
  to: Status;
  by: Writer;
}

// format-spec §1.2, verbatim.
export const TRANSITIONS: readonly Transition[] = [
  // ── plan branch: only pre-v2 maps still carry plan-step nodes with these statuses; dev-planning
  // v2 (decision 55) tracks phase progress as checkboxes in the plan document, not as statuses. ──
  { from: 'planned', to: 'in-progress', by: 'executor' },
  { from: 'in-progress', to: 'done', by: 'executor' },
  { from: 'in-progress', to: 'blocked', by: 'executor' },
  { from: 'blocked', to: 'in-progress', by: 'executor' },
  { from: 'done', to: 'ok', by: 'sync' }, // the single point a plan-step becomes a rule
  // ── code branch ──
  { from: 'ok', to: 'stale', by: 'system' }, // hash diverged; not yet judged
  { from: 'drift', to: 'stale', by: 'system' }, // a fresh divergence on top of any state
  { from: 'stale', to: 'ok', by: 'sync' }, // judged: cosmetic
  { from: 'stale', to: 'drift', by: 'sync' }, // judged: behaviour changed
  { from: 'drift', to: 'ok', by: 'scanner' }, // rescan / "update spec from code"
];

const KEY = (from: Status, to: Status, by: Writer): string => `${from}>${to}:${by}`;
const LEGAL = new Set(TRANSITIONS.map((t) => KEY(t.from, t.to, t.by)));

/** True if `by` is permitted to move a node from `from` to `to`. Identity (from === to) is a no-op. */
export function canTransition(from: Status, to: Status, by: Writer): boolean {
  if (from === to) return true;
  return LEGAL.has(KEY(from, to, by));
}

/** Thrown when a status change violates the machine. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: Status,
    readonly to: Status,
    readonly by: Writer,
  ) {
    super(`Illegal status transition ${from} → ${to} by ${by} (format-spec §1.2).`);
    this.name = 'IllegalTransitionError';
  }
}

/** Assert a transition is legal; throw {@link IllegalTransitionError} otherwise. */
export function assertTransition(from: Status, to: Status, by: Writer): void {
  if (!canTransition(from, to, by)) throw new IllegalTransitionError(from, to, by);
}

// Roll-up priority for aggregation to parents (format-spec §1.3): worst wins.
const ROLLUP_ORDER: readonly Status[] = [
  'drift',
  'blocked',
  'stale',
  'in-progress',
  'planned',
  'done',
  'ok',
];
const ROLLUP_RANK = new Map<Status, number>(ROLLUP_ORDER.map((s, i) => [s, i]));

/** The worse (higher-priority) of two statuses per format-spec §1.3. */
export function worseStatus(a: Status, b: Status): Status {
  return (ROLLUP_RANK.get(a) ?? Infinity) <= (ROLLUP_RANK.get(b) ?? Infinity) ? a : b;
}

export { ROLLUP_ORDER };
