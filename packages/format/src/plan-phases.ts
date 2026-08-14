// Dev-planning v2 (decision 55): the single roadmap plan document is markdown — `## Phase N — …`
// headings with `- [ ] / - [x]` checklist items. These pure helpers parse the phases and check a
// phase off, so both the executor pipeline (main) and the UI agree on structure. No IO here.

export interface PlanItem {
  text: string;
  done: boolean;
}
export interface PlanPhase {
  index: number; // 0-based order in the document
  title: string; // the heading text after "## "
  items: PlanItem[];
  done: boolean; // every item checked (and there is at least one)
  note?: string; // the system's outcome line for a finished phase (see setPhaseNote)
}

const HEADING = /^##\s+(.*\S)\s*$/;
const CHECK_ITEM = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;
// The one line the system owns inside a phase: what the run produced. A blockquote so a human
// reading the raw markdown sees it as an aside, not as work still to do.
const NOTE = /^>\s*✓\s*(.*)$/;
const NOTE_PREFIX = '> ✓ ';

/** Parse the phases (headings + checklist items + outcome note) out of a plan document body. */
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

/**
 * Write the outcome of a finished phase into the plan document itself, right under that phase's
 * checklist — replacing any note already there, so a re-run updates rather than accumulates.
 * Dev-planning v2 (decision 55) has no per-phase node files: the plan IS the record of what was
 * built, so a reader sees the intent and its result in one place.
 */
export function setPhaseNote(body: string, phaseIndex: number, note: string): string {
  const lines = body.split('\n');
  let seen = -1;
  let start = -1; // first line of the target phase's content
  let end = lines.length; // exclusive — where the next phase begins
  for (let i = 0; i < lines.length; i++) {
    if (!HEADING.test(lines[i]!)) continue;
    seen += 1;
    if (seen === phaseIndex) start = i + 1;
    else if (start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0) return body; // no such phase — leave the document alone

  const section = lines.slice(start, end).filter((l) => !NOTE.test(l));
  while (section.length > 0 && section[section.length - 1]!.trim() === '') section.pop();
  section.push('', `${NOTE_PREFIX}${note.trim()}`, '');
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n');
}

/** Return the body with every checklist item under the Nth phase marked done (`- [x]`). */
export function markPhaseDone(body: string, phaseIndex: number): string {
  let seen = -1;
  return body
    .split('\n')
    .map((line) => {
      if (HEADING.test(line)) {
        seen += 1;
        return line;
      }
      if (seen === phaseIndex) {
        const it = CHECK_ITEM.exec(line);
        if (it && it[2] === ' ') return `${it[1]}[x] ${it[3]}`;
      }
      return line;
    })
    .join('\n');
}
