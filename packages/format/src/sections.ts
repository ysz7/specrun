// Body sections (format-spec §4). A feature's body is a statement plus `## …` sections, and each
// section exists once: Deepen enriches a node by rewriting its body, so without this a second pass
// appends another `## Invariants` under the first and the node slowly becomes two documents stapled
// together. The write path folds repeats back into the first occurrence — the tool holds the shape
// rather than asking the agent to remember it.

/** A parsed body: the statement before the first `## `, then its sections in order. */
export interface BodySections {
  statement: string;
  sections: { heading: string; lines: string[] }[];
}

const HEADING = /^##\s+(.+?)\s*$/;
const key = (heading: string): string => heading.trim().toLowerCase();

/** Split a body into its statement and `## ` sections (headings kept verbatim). */
export function parseSections(body: string): BodySections {
  const lines = body.split(/\r?\n/);
  const statement: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let fenced = false; // a `## ` inside a code block is code, not a heading
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line);
    if (match) sections.push({ heading: match[1]!, lines: [] });
    else if (sections.length === 0) statement.push(line);
    else sections.at(-1)!.lines.push(line);
  }
  return { statement: statement.join('\n').trim(), sections };
}

/**
 * Fold repeated sections into their first occurrence, keeping first-seen order and dropping lines
 * the section already carries verbatim. A second `## Invariants` that only restates the first one
 * disappears; one that adds a line contributes that line where it belongs.
 */
export function mergeDuplicateSections(body: string): string {
  const { statement, sections } = parseSections(body);
  if (sections.length === 0) return body.trim();

  const merged: { heading: string; lines: string[] }[] = [];
  const byKey = new Map<string, { heading: string; lines: string[] }>();
  for (const section of sections) {
    const existing = byKey.get(key(section.heading));
    if (!existing) {
      const fresh = { heading: section.heading, lines: [...section.lines] };
      byKey.set(key(section.heading), fresh);
      merged.push(fresh);
      continue;
    }
    const seen = new Set(existing.lines.map((l) => l.trim()).filter((l) => l.length > 0));
    for (const line of section.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || !seen.has(trimmed)) existing.lines.push(line);
      if (trimmed.length > 0) seen.add(trimmed);
    }
  }

  const out = [statement];
  for (const section of merged) {
    const content = section.lines.join('\n').trim();
    out.push(`## ${section.heading}${content ? `\n${content}` : ''}`);
  }
  return out
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trim();
}

/** Where in a body something is spoken about (Phase 6): a named section, or the opening statement. */
export type BodyPlace = { where: 'section'; heading: string } | { where: 'statement' };

/** A place as one short phrase, for a prompt, a drift-log line or a card. */
export function describePlace(place: BodyPlace): string {
  return place.where === 'statement' ? 'the opening statement' : `## ${place.heading}`;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which part of a feature's body talks about `needle` (a symbol name), or `null` when nothing does.
 *
 * This is the compensation decision 56 accepted a debt for: a feature carries many anchors, so
 * "something inside «Adding a task» changed" is a blunter signal than the one-assertion-per-node
 * form gave. Rather than asking the scanner to declare which section each anchor belongs to — a
 * schema field the model can get wrong, and one that would do nothing for every feature already on
 * disk — the link is *derived*: the section that names the symbol is the part of the feature that
 * moved. Matching is word-bounded so `save` does not hit `saveAll`, and `_`/`$` count as word
 * characters because symbol names use them.
 */
export function locateInBody(body: string, needle: string): BodyPlace | null {
  const term = needle.trim();
  if (term.length === 0) return null;
  const mentions = new RegExp(`(^|[^\\w$])${escape(term)}([^\\w$]|$)`);
  const { statement, sections } = parseSections(body);
  for (const section of sections) {
    if (mentions.test(section.lines.join('\n')))
      return { where: 'section', heading: section.heading };
  }
  return mentions.test(statement) ? { where: 'statement' } : null;
}
