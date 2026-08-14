// index.json — the cache, never the truth (format-spec §6). Rebuilt by a full pass over the
// parsed nodes (<50ms for 1000 files), never committed. Parent/child structure comes from the
// folder layout; roll-ups bubble the worst descendant status per §1.3.
import { hasStatus, type NodeMeta, type Status } from './schema.js';
import { worseStatus } from './statuses.js';

/** One node offered to the index: its path within `.alethic/`, its meta, and any extra flags. */
export interface IndexEntry {
  path: string;
  meta: NodeMeta;
  flags?: string[];
}

export interface IndexNode {
  path: string;
  kind: NodeMeta['kind'];
  title: string;
  status?: Status;
  parent?: string;
  flags?: string[];
}

export interface Rollup {
  n: number;
  worst?: Status;
  ok?: number;
  drift?: number;
  stale?: number;
  planned?: number;
  'in-progress'?: number;
  done?: number;
  blocked?: number;
}

export interface IndexJson {
  built_at: string;
  format: 1;
  nodes: Record<string, IndexNode>;
  tree: Record<string, string[]>;
  by_file: Record<string, string[]>;
  affected_by: Record<string, string[]>;
  rollup: Record<string, Rollup>;
}

// ── path helpers (posix, `.alethic/`-relative) ─────────────────────────────
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const dirOf = (p: string): string => {
  const i = norm(p).lastIndexOf('/');
  return i < 0 ? '' : norm(p).slice(0, i);
};
const baseOf = (p: string): string => {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i < 0 ? n : n.slice(i + 1);
};

// `_section.md` (decision 55) sits directly in `plans/` and `domains/`, so being a container is all
// it takes to split the pyramid into the "Plan" and "Code" branches: every plan/domain below it
// re-parents onto the section instead of the root. No special-casing in the tree walk.
const CONTAINER_BASES = new Set([
  'alethic.md',
  '_section.md',
  '_domain.md',
  '_sub.md',
  '_plan.md',
  '_note.md',
]);
const isContainer = (path: string): boolean => CONTAINER_BASES.has(baseOf(path));

/** Ancestor directories of `dir`, nearest first (excluding `dir` itself). */
function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  while (cur !== '') {
    cur = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
    out.push(cur);
  }
  return out;
}

function computeFlags(entry: IndexEntry): string[] | undefined {
  const flags = new Set(entry.flags ?? []);
  const meta = entry.meta;
  if (
    (meta.kind === 'domain' || meta.kind === 'sub' || meta.kind === 'rule') &&
    meta.depth === 'shallow'
  )
    flags.add('shallow');
  // A feature that has been through a Deepen pass (decision 56): the card says so, so "no marker"
  // honestly reads as "nobody has looked closely at this one yet".
  if (meta.kind === 'rule' && meta.depth === 'full') flags.add('deepened');
  if (
    (meta.kind === 'rule' || meta.kind === 'plan-step') &&
    meta.anchors.some((a) => a.symbol === undefined)
  ) {
    flags.add('file-anchored');
  }
  return flags.size > 0 ? [...flags] : undefined;
}

/** Build a fresh index from the full set of parsed nodes. */
export function buildIndex(
  entries: IndexEntry[],
  now: () => string = () => new Date().toISOString(),
): IndexJson {
  const byId = new Map<string, IndexEntry>();
  const idByDir = new Map<string, string>(); // container dir → node id
  for (const e of entries) {
    byId.set(e.meta.id, e);
    if (isContainer(e.path)) idByDir.set(dirOf(e.path), e.meta.id);
  }

  // A node hangs from the nearest container at or above its folder. Walking *up* rather than
  // demanding an exact-directory container matters: a map whose `_domain.md`/`_sub.md`/`_plan.md`
  // is missing (hand-edited, half-migrated, written by a tool that forgot the card) would otherwise
  // leave its rules parentless — present on disk, absent from every subtree, invisible in the
  // pyramid. Absence reads as "this does not exist", so nothing is ever dropped: it re-parents to
  // whatever container does exist, up to the root.
  const parentOf = (e: IndexEntry): string | undefined => {
    const dir = dirOf(e.path);
    if (!isContainer(e.path)) {
      const own = idByDir.get(dir);
      if (own) return own;
    }
    for (const anc of ancestorDirs(dir)) {
      const id = idByDir.get(anc);
      if (id && id !== e.meta.id) return id;
    }
    return undefined; // the apex itself
  };

  const nodes: Record<string, IndexNode> = {};
  const tree: Record<string, string[]> = {};
  const by_file: Record<string, string[]> = {};
  const affected_by: Record<string, string[]> = {};

  for (const e of entries) {
    const parent = parentOf(e);
    const flags = computeFlags(e);
    nodes[e.meta.id] = {
      path: norm(e.path),
      kind: e.meta.kind,
      title: e.meta.title,
      ...(hasStatus(e.meta) ? { status: e.meta.status } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(flags !== undefined ? { flags } : {}),
    };
    if (parent !== undefined) (tree[parent] ??= []).push(e.meta.id);

    if (e.meta.kind === 'rule' || e.meta.kind === 'plan-step') {
      for (const anchor of e.meta.anchors) {
        const file = norm(anchor.file);
        const list = (by_file[file] ??= []);
        if (!list.includes(e.meta.id)) list.push(e.meta.id);
      }
    }
    if (e.meta.kind === 'rule') {
      for (const target of e.meta.affects) (affected_by[target] ??= []).push(e.meta.id);
    }
  }

  // Deterministic child order: by `order` (if set), then by path.
  for (const id of Object.keys(tree)) {
    tree[id]!.sort((a, b) => {
      const ea = byId.get(a)?.meta;
      const eb = byId.get(b)?.meta;
      const oa = ea?.order ?? Number.MAX_SAFE_INTEGER;
      const ob = eb?.order ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return (nodes[a]?.path ?? '').localeCompare(nodes[b]?.path ?? '');
    });
  }

  const rollup = computeRollups(entries, tree, byId);
  return { built_at: now(), format: 1, nodes, tree, by_file, affected_by, rollup };
}

function computeRollups(
  entries: IndexEntry[],
  tree: Record<string, string[]>,
  byId: Map<string, IndexEntry>,
): Record<string, Rollup> {
  const rollup: Record<string, Rollup> = {};
  const memo = new Map<string, Rollup>();

  const compute = (id: string): Rollup => {
    const cached = memo.get(id);
    if (cached) return cached;
    const meta = byId.get(id)?.meta;
    const children = tree[id] ?? [];
    if (children.length === 0) {
      // leaf: counts as one node of its own status (if it has one)
      const r: Rollup = { n: 1 };
      if (meta && hasStatus(meta)) {
        r[meta.status] = 1;
        r.worst = meta.status;
      } else {
        r.n = 0;
      }
      memo.set(id, r);
      return r;
    }
    const acc: Rollup = { n: 0 };
    for (const child of children) {
      const cr = compute(child);
      acc.n += cr.n;
      for (const key of [
        'ok',
        'drift',
        'stale',
        'planned',
        'in-progress',
        'done',
        'blocked',
      ] as const) {
        if (cr[key]) acc[key] = (acc[key] ?? 0) + cr[key]!;
      }
      if (cr.worst) acc.worst = acc.worst ? worseStatus(acc.worst, cr.worst) : cr.worst;
    }
    memo.set(id, acc);
    return acc;
  };

  for (const e of entries) {
    const children = tree[e.meta.id] ?? [];
    if (children.length > 0) rollup[e.meta.id] = compute(e.meta.id);
  }
  return rollup;
}

/** A change to one file: an upsert (entry present) or a delete (entry omitted). */
export interface IndexChange {
  path: string;
  entry?: IndexEntry;
}

/**
 * Apply an incremental single-file change to the working entry set (O(1)), keyed by path. The
 * caller then calls {@link buildIndex} on the values — no re-reading the whole `.alethic/`.
 */
export function applyPatch(
  entries: Map<string, IndexEntry>,
  change: IndexChange,
): Map<string, IndexEntry> {
  const key = norm(change.path);
  if (change.entry) entries.set(key, { ...change.entry, path: key });
  else entries.delete(key);
  return entries;
}

/** Convenience: a Map keyed by normalized path, ready for {@link applyPatch}. */
export function toEntryMap(entries: IndexEntry[]): Map<string, IndexEntry> {
  return new Map(entries.map((e) => [norm(e.path), { ...e, path: norm(e.path) }]));
}
