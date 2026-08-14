// Renderer-side copy of the plan-phase parser (decision 55). The renderer may not import
// @alethic/format (import rule 1), so this mirrors packages/format/src/plan-phases.ts — keep them
// in sync. Parse only; the write side (ticking checkboxes) lives in main.
export interface PlanItem {
  text: string;
  done: boolean;
}
export interface PlanPhase {
  index: number;
  title: string;
  items: PlanItem[];
  done: boolean;
  note?: string; // what the run produced, written into the plan by the system
}

const HEADING = /^##\s+(.*\S)\s*$/;
const CHECK_ITEM = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;
const NOTE = /^>\s*✓\s*(.*)$/;

/** Parse `## Phase …` headings + `- [ ]/[x]` items + the outcome note out of a plan body. */
export function parsePlanPhases(body: string): PlanPhase[] {
  const phases: PlanPhase[] = [];
  let cur: PlanPhase | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      cur = { index: phases.length, title: h[1]!.trim(), items: [], done: false };
      phases.push(cur);
      continue;
    }
    if (!cur) continue;
    const it = CHECK_ITEM.exec(line);
    if (it) {
      cur.items.push({ text: it[3]!.trim(), done: it[2]!.toLowerCase() === 'x' });
      continue;
    }
    const note = NOTE.exec(line);
    if (note) cur.note = cur.note ? `${cur.note}\n${note[1]!.trim()}` : note[1]!.trim();
  }
  for (const p of phases) p.done = p.items.length > 0 && p.items.every((i) => i.done);
  return phases;
}
