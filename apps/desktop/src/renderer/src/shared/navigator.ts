// Navigator glue (Phase 8): builds the light chat context (decision 20), extracts the node ids the
// Navigator cited so the chat can link them to the pyramid (decision 21), and detects a plan
// proposal by its [[PLAN]] marker (creation itself is Phase 9). Pure functions — unit-tested.
import { childrenOf, type AtlasVm } from './viewmodel';

export interface NavigatorView {
  apexId: string;
  focusId: string | null;
  expandedId: string | null;
}

/** Marker the Navigator appends to a plan proposal; the UI turns it into a Create-plan affordance. */
export const PLAN_MARKER = '[[PLAN]]';

// Node id shape: <1–2 letter prefix>-<6 hex> (format-spec §4 Base.id).
const ID_RE = /\b[a-z]{1,2}-[0-9a-f]{6}\b/g;

/**
 * The light context handed to the Navigator (decision 20): a one-line-per-domain map summary plus
 * the current view and open node. Everything deeper is left to alethic_read_map / read tools.
 */
export function buildNavigatorContext(vm: AtlasVm, view: NavigatorView): string {
  // Every domain, wherever it hangs: since decision 55 they sit under the "Code" section, not the apex.
  const domains = [...vm.byId.values()].filter((n) => n.kind === 'domain');
  const totalRules = Object.values(vm.index.nodes).filter((n) => n.kind === 'rule').length;

  const domainLines = domains.map((d) => {
    const r = d.rollup;
    const bits = r
      ? [
          `${r.n} rules`,
          `worst ${r.worst ?? 'ok'}`,
          r.drift ? `${r.drift} drift` : '',
          r.stale ? `${r.stale} stale` : '',
        ].filter(Boolean)
      : [];
    return `- ${d.title} (${d.id})${bits.length ? ` — ${bits.join(', ')}` : ''}`;
  });

  const apex = vm.byId.get(view.apexId);
  const focus = view.focusId ? vm.byId.get(view.focusId) : undefined;
  const open = view.expandedId ? vm.byId.get(view.expandedId) : undefined;

  // Give a little local detail for the focused branch (its direct children).
  const focusKids = focus ? childrenOf(vm, focus.id) : [];
  const focusLines = focusKids.map(
    (k) => `  · ${k.title} (${k.id})${k.status ? ` [${k.status}]` : ''}`,
  );

  return [
    `[MAP CONTEXT] Project "${vm.projectTitle}" — ${totalRules} rules across ${domains.length} domains.`,
    `Domains:`,
    ...domainLines,
    apex ? `Current apex: ${apex.title} (${apex.id}).` : '',
    focus ? `Focused branch: ${focus.title} (${focus.id}).` : '',
    ...(focusLines.length ? [`Focused branch children:`, ...focusLines] : []),
    open
      ? `Open node: ${open.title} (${open.id})${open.status ? `, status ${open.status}` : ''}.`
      : '',
    `Cite node ids inline so I can link them. Use alethic_read_map and read tools for anything not summarized here.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The node ids the Navigator cited that actually exist in the map, in first-seen order. */
export function citedNodeIds(text: string, vm: AtlasVm): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(ID_RE)) {
    const id = match[0];
    if (vm.byId.has(id) && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** Detect and strip the plan-proposal marker. */
export function detectPlanProposal(text: string): { isPlan: boolean; clean: string } {
  const isPlan = text.includes(PLAN_MARKER);
  const clean = text.split(PLAN_MARKER).join('').trimEnd();
  return { isPlan, clean };
}

export interface TextSegment {
  text: string;
  nodeId?: string; // present when this segment is a clickable, existing-node id
}

/** Split a message into plain-text and cited-node-id segments for rich rendering. */
export function segmentMessage(text: string, vm: AtlasVm): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(ID_RE)) {
    const id = match[0];
    const start = match.index ?? 0;
    if (!vm.byId.has(id)) continue;
    if (start > last) segments.push({ text: text.slice(last, start) });
    segments.push({ text: id, nodeId: id });
    last = start + id.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments.length ? segments : [{ text }];
}
