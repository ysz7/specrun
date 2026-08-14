// Node → md. A single canonical key order per kind, empty/default optionals omitted, and
// double-quoted scalars (so ISO timestamps never round-trip through a YAML Date). The point is
// byte-stable output: the same node always serializes identically, so git diffs stay atomic.
import { stringify as yamlStringify } from 'yaml';
import type { Anchor, Kind, NodeMeta } from './schema.js';

// Canonical frontmatter key order per kind (format-spec §4). Keys absent from a node are skipped.
const KEY_ORDER: Record<Kind, readonly string[]> = {
  root: ['id', 'kind', 'title', 'order', 'created', 'updated', 'updated_by'],
  section: ['id', 'kind', 'title', 'branch', 'icon', 'order', 'created', 'updated', 'updated_by'],
  domain: [
    'id',
    'kind',
    'title',
    'scope',
    'icon',
    'depth',
    'order',
    'created',
    'updated',
    'updated_by',
  ],
  sub: ['id', 'kind', 'title', 'scope', 'depth', 'order', 'created', 'updated', 'updated_by'],
  rule: [
    'id',
    'kind',
    'title',
    'status',
    'provenance',
    'locked',
    'anchors',
    'affects',
    'tests',
    'depth',
    'order',
    'created',
    'updated',
    'updated_by',
  ],
  plan: ['id', 'kind', 'title', 'goal', 'domains', 'order', 'created', 'updated', 'updated_by'],
  note: [
    'id',
    'kind',
    'title',
    'provenance',
    'locked',
    'order',
    'created',
    'updated',
    'updated_by',
  ],
  'plan-step': [
    'id',
    'kind',
    'title',
    'status',
    'accept',
    'depends_on',
    'anchors',
    'blocked_reason',
    'order',
    'created',
    'updated',
    'updated_by',
  ],
};

const ANCHOR_KEYS = ['file', 'symbol', 'span', 'hash', 'dochash'] as const;

/** Values that carry no information and are dropped for clean diffs: undefined, `false` locked, empty arrays. */
function isOmittable(key: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (key === 'locked' && value === false) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function orderAnchor(anchor: Anchor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ANCHOR_KEYS) {
    const value = (anchor as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Build a plain object with keys in canonical order, omitting empties. */
function orderMeta(meta: NodeMeta): Record<string, unknown> {
  const source = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER[meta.kind]) {
    const value = source[key];
    if (isOmittable(key, value)) continue;
    out[key] = key === 'anchors' ? (value as Anchor[]).map(orderAnchor) : value;
  }
  return out;
}

/** Serialize a node (frontmatter + markdown body) to its canonical, byte-stable text form. */
export function serialize(file: { meta: NodeMeta; body?: string }): string {
  const yaml = yamlStringify(orderMeta(file.meta), {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  }).trimEnd();
  const front = `---\n${yaml}\n---\n`;
  const body = (file.body ?? '').trim();
  return body ? `${front}\n${body}\n` : front;
}
