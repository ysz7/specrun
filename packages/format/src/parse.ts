// md + frontmatter → validated Node. The parser must survive git conflict markers: a node with
// markers gets `conflict: true` and keeps its raw text, so a stray `git pull` never breaks the map
// (decision 41). Timestamps are parsed as strings (YAML 1.2 core schema), never coerced to Date.
import matter from 'gray-matter';
import { parse as yamlParse } from 'yaml';
import {
  Config,
  KINDS,
  schemaForKind,
  type Config as ConfigType,
  type Kind,
  type NodeMeta,
} from './schema.js';
import type { z } from 'zod';

/** A git conflict marker on its own line: `<<<<<<<`, `=======`, or `>>>>>>>`. */
const CONFLICT_RE = /^(<{7}|={7}|>{7})(\s|$)/m;

export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_RE.test(text);
}

/** A parsed `.alethic/` markdown file. `meta` is null only when conflict markers corrupt the frontmatter. */
export interface ParsedFile {
  meta: NodeMeta | null;
  body: string;
  conflict: boolean;
  raw: string;
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly issues?: z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

const yamlEngine = {
  parse: (s: string): object => (yamlParse(s) as object) ?? {},
  stringify: (): string => {
    throw new Error('serialize() owns frontmatter emission, not gray-matter');
  },
};

/** Normalize a markdown body: drop the leading blank line gray-matter leaves, trim the tail, end with one newline. */
function normalizeBody(body: string): string {
  const trimmed = body.replace(/^\r?\n/, '').replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}

/**
 * CRLF is not a dialect of the format, it is an artifact of the filesystem the file crossed. A
 * `.alethic/` tree checked out on Windows with `core.autocrlf=true`, or a node saved by an editor
 * that writes CRLF, arrives with `\r\n` — and gray-matter's frontmatter split does not survive it:
 * every node fails to parse and the whole map reads as empty. Found by CI on a Windows runner while
 * the same commit was green on the author's Windows machine, whose working copy still held LF.
 * Everything downstream already splits on `/\r?\n/`; normalizing at the single entry point means it
 * only has to be true here. `raw` keeps the bytes as they were — it is what the conflict view shows.
 */
const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');

/** Parse one `.alethic/` markdown file into a validated node. Throws {@link ParseError} unless conflicted. */
export function parse(raw: string): ParsedFile {
  const text = normalizeEol(raw);
  const conflict = hasConflictMarkers(text);
  let data: Record<string, unknown>;
  let body: string;
  try {
    const fm = matter(text, { engines: { yaml: yamlEngine } });
    data = fm.data as Record<string, unknown>;
    body = fm.content;
  } catch (err) {
    if (conflict) return { meta: null, body: text, conflict: true, raw };
    throw new ParseError(`Invalid frontmatter YAML: ${(err as Error).message}`);
  }

  const kind = data['kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    if (conflict) return { meta: null, body: normalizeBody(body), conflict: true, raw };
    throw new ParseError(`Missing or unknown kind: ${String(kind)}`);
  }

  const result = schemaForKind(kind as Kind).safeParse(data);
  if (!result.success) {
    if (conflict) return { meta: null, body: normalizeBody(body), conflict: true, raw };
    throw new ParseError(`Frontmatter failed schema for kind "${kind}"`, result.error.issues);
  }

  return { meta: result.data as NodeMeta, body: normalizeBody(body), conflict, raw };
}

/** Parse `config.yaml` (format-spec §3). */
export function parseConfig(text: string): ConfigType {
  const parsed = yamlParse(normalizeEol(text)) as unknown;
  return Config.parse(parsed);
}
