// Load a `.alethic/` directory from disk into parsed nodes + config. The read side of the format,
// shared by the validator and (from Phase 2) the AtlasService.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, ParseError, parseConfig } from './parse.js';
import { LEGACY_FLAG, legacyFormViolation } from './form.js';
import type { IndexEntry } from './index-builder.js';
import type { Config, NodeMeta } from './schema.js';

/** A `.alethic/` file after an attempted parse (meta null when conflict markers corrupt it). */
export interface LoadedNode {
  path: string; // posix, relative to the .alethic dir
  meta: NodeMeta | null;
  body: string;
  conflict: boolean;
  parseError?: string;
}

export interface LoadedProject {
  nodes: LoadedNode[];
  config?: Config;
}

const posix = (p: string): string => p.replace(/\\/g, '/');

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out; // an unmapped project: no .alethic/ yet
  for (const entry of readdirSync(dir)) {
    // Skip dot-dirs: `.backup/` holds pre-destructive snapshots (decision 43), not live nodes —
    // loading them would duplicate the whole map and corrupt the tree.
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Read and parse every node in a `.alethic/` directory, plus `config.yaml` if present. */
export function loadAlethicDir(alethicDir: string): LoadedProject {
  const nodes: LoadedNode[] = [];
  for (const abs of walkMarkdown(alethicDir).sort()) {
    const path = posix(relative(alethicDir, abs));
    const text = readFileSync(abs, 'utf8');
    try {
      const parsed = parse(text);
      nodes.push({ path, meta: parsed.meta, body: parsed.body, conflict: parsed.conflict });
    } catch (err) {
      const message = err instanceof ParseError ? err.message : (err as Error).message;
      nodes.push({ path, meta: null, body: '', conflict: false, parseError: message });
    }
  }

  const configPath = join(alethicDir, 'config.yaml');
  let config: Config | undefined;
  if (existsSync(configPath)) {
    try {
      config = parseConfig(readFileSync(configPath, 'utf8'));
    } catch {
      /* config schema problems surface via its own validation, not node loading */
    }
  }
  return { nodes, ...(config ? { config } : {}) };
}

/**
 * Keep only successfully-parsed nodes as index entries. The form flag is attached here rather than
 * in the index builder because it is the one property of a node that needs its *body*, and the
 * builder only ever sees frontmatter (Phase 6): a map still in the pre-feature form has to say so
 * on the card, and silence is the failure mode decision 56 called the worst of all.
 */
export function toIndexEntries(nodes: LoadedNode[]): IndexEntry[] {
  return nodes
    .filter((n): n is LoadedNode & { meta: NodeMeta } => n.meta !== null)
    .map((n) => ({ path: n.path, meta: n.meta, ...entryFlags(n.meta, n.body) }));
}

/** Body-derived index flags for one node (see {@link toIndexEntries}). */
export function entryFlags(meta: NodeMeta, body: string): { flags?: string[] } {
  return legacyFormViolation(meta, body) ? { flags: [LEGACY_FLAG] } : {};
}
