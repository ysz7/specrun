// The title norm (format-spec §2, decision 56). A node's title is its NAME — "Adding a task", not
// "`add`'s confirmation line appends a due suffix iff `task.due` is truthy". The full assertion is
// the first line of the body; the title is what a card in the pyramid is called. `max(120)` in the
// schema is the format's ceiling, this is the norm: the MCP tools reject a write above it (the agent
// renames and retries) and the validator warns about what has already accumulated on disk.
export const TITLE_MAX = 70;

/**
 * Why `title` is not a name, or `null` when it is fine. One reason, phrased for the agent: it is
 * handed back as a structured tool error, so it has to say what to do, not just what is wrong.
 */
export function titleNormViolation(title: string): string | null {
  const t = title.trim();
  if (t.length > TITLE_MAX)
    return `title is ${t.length} characters (norm: ≤ ${TITLE_MAX}) — name the feature and move the full statement into the body`;
  if (/[.…]$/.test(t))
    return 'title ends with a period — that is an assertion, not a name; the assertion belongs on the first line of the body';
  if (t.includes('`'))
    return 'title contains backticked code — name the feature in plain words and keep the code in the body';
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode the handful of HTML entities a model sometimes escapes into a title or description
 * ("Node schema & identity" comes back as "Node schema &amp; identity"). Applied at every point a
 * model-supplied title enters the format, so neither the card nor `slugify` ever sees the escape.
 * An entity this doesn't recognise is left as-is rather than guessed at.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
}
