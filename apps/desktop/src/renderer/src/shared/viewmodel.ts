// Selector: AtlasSnapshot (flat index + node bodies) → a navigable tree the pyramid can render.
// The renderer holds no fake state; every view derives from the snapshot the main process sent.
import type {
  AtlasSnapshot,
  IndexJson,
  Kind,
  Rollup,
  SnapshotNode,
  Status,
} from '../entities/node';

export interface VmNode {
  id: string;
  kind: Kind;
  title: string;
  status?: Status;
  flags: string[];
  parent?: string;
  path: string;
  children: string[];
  rollup?: Rollup;
}

export interface AtlasVm {
  root: string;
  projectId: string;
  projectTitle: string;
  byId: Map<string, VmNode>;
  nodeByPath: Map<string, SnapshotNode>;
  index: IndexJson;
}

export function buildVm(snapshot: AtlasSnapshot): AtlasVm {
  const { index } = snapshot;
  const byId = new Map<string, VmNode>();
  for (const [id, n] of Object.entries(index.nodes)) {
    byId.set(id, {
      id,
      kind: n.kind,
      title: n.title,
      ...(n.status ? { status: n.status } : {}),
      flags: n.flags ?? [],
      ...(n.parent ? { parent: n.parent } : {}),
      path: n.path,
      children: index.tree[id] ?? [],
      ...(index.rollup[id] ? { rollup: index.rollup[id] } : {}),
    });
  }
  const projectId = Object.keys(index.nodes).find((id) => !index.nodes[id]!.parent) ?? '';
  const nodeByPath = new Map(snapshot.nodes.map((n) => [n.path, n]));
  return {
    root: snapshot.root,
    projectId,
    projectTitle: byId.get(projectId)?.title ?? 'Alethic',
    byId,
    nodeByPath,
    index,
  };
}

export function childrenOf(vm: AtlasVm, id: string): VmNode[] {
  return (vm.byId.get(id)?.children ?? [])
    .map((c) => vm.byId.get(c))
    .filter((n): n is VmNode => !!n);
}

/**
 * The chain from the project apex down to (but excluding) `id` — the breadcrumb of a re-rooted view.
 * Depth is not limited any more (decision 56): a feature that filled up became a layer, so "back"
 * can no longer mean only "back to the project" — every ancestor has to be one click away.
 */
export function ancestorsOf(vm: AtlasVm, id: string): VmNode[] {
  const chain: VmNode[] = [];
  const seen = new Set<string>([id]);
  let cur = vm.byId.get(id)?.parent;
  while (cur && !seen.has(cur)) {
    seen.add(cur); // a cycle would otherwise hang the renderer, and the index is a cache
    const node = vm.byId.get(cur);
    if (!node) break;
    chain.unshift(node);
    cur = node.parent;
  }
  return chain;
}

/** The first non-empty line of a node's body — a container's own assertion (decision 56's roof). */
export function statementOf(vm: AtlasVm, id: string): string {
  const body = snapshotNode(vm, id)?.body ?? '';
  return (body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? '').trim();
}

export function snapshotNode(vm: AtlasVm, id: string): SnapshotNode | undefined {
  const path = vm.byId.get(id)?.path;
  return path ? vm.nodeByPath.get(path) : undefined;
}

/**
 * Which branch of the pyramid a node belongs to (decision 55): `plan` — what we intend to build,
 * `code` — what the code actually does. Derived from the path, so it holds for the branch roots and
 * everything under them; plan-mode notes belong to neither.
 */
export function branchOf(node: VmNode): 'plan' | 'code' | null {
  if (node.path.startsWith('plans/')) return 'plan';
  if (node.path.startsWith('domains/')) return 'code';
  return null;
}

/** Count of drifting descendants (for the ⚠ chip badge). */
export function driftCount(node: VmNode): number {
  return node.rollup?.drift ?? 0;
}
