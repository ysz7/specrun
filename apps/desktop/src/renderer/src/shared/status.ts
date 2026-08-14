// Status → visual language (format-spec §1: solid = confirmed by code, dashed = not confirmed).
// drift/stale and every plan status render dashed; ok renders solid. Conflict and shallow are
// flags layered on top.
import { T } from './tokens';
import type { Status } from '../entities/node';

export interface NodeVisual {
  dashed: boolean;
  border: string;
  dot: string; // status dot colour
  label: string;
}

const RED = new Set<Status>(['drift', 'blocked']);
const MUTED_DASH = new Set<Status>(['stale', 'planned', 'in-progress', 'done']);

export function visualFor(status: Status | undefined, flags: readonly string[] = []): NodeVisual {
  const conflict = flags.includes('conflict');
  if (conflict) {
    return { dashed: true, border: T.orange, dot: T.orange, label: 'conflict' };
  }
  if (status && RED.has(status)) {
    return { dashed: true, border: T.orange, dot: T.orange, label: status };
  }
  if (status && MUTED_DASH.has(status)) {
    return { dashed: true, border: T.line, dot: T.faint, label: status };
  }
  // ok (or a container with no worst status)
  return { dashed: false, border: T.line, dot: T.green, label: status ?? 'ok' };
}

/** Whether a node carries the shallow-scan mark (decision 39). */
export const isShallow = (flags: readonly string[]): boolean => flags.includes('shallow');
export const isConflict = (flags: readonly string[]): boolean => flags.includes('conflict');
export const isFileAnchored = (flags: readonly string[]): boolean =>
  flags.includes('file-anchored');
