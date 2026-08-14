// The validator (format-spec §7). Two levels: `error` (a file the MCP tools would reject / that
// reddens in the UI) and `warn`. Issues are structured objects — the same shape the MCP tools will
// hand back to the agent, so it can fix and retry rather than guess.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLACEHOLDER_CONTAINER_BODY } from './form.js';
import { buildIndex, type IndexEntry } from './index-builder.js';
import { loadAlethicDir } from './load.js';
import { slugify } from './ids.js';
import { titleNormViolation } from './titles.js';
import { type Config, type NodeMeta } from './schema.js';

/**
 * How many children a domain/sub may hold before it stops being one thought (decision 56: a group
 * has 3–7 siblings and a roof that summarizes them). This — not `max_rules_per_sub` — is the
 * measure of granularity now: a ninth sibling means either a layer is missing or features were
 * sliced into sentences. The branch containers (root, section) are exempt: the width of the domain
 * list is set by decomposition (decision 11: 4–15 domains), not by Minto.
 */
const CONTAINER_MAX_CHILDREN = 7;

export type IssueLevel = 'error' | 'warn';

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  path: string;
  id?: string;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  errors: number;
  warnings: number;
  ok: boolean;
}

/** A `.alethic/` file after an attempted parse (meta null when conflict markers corrupt it). */
export interface LoadedFile {
  path: string; // repo-relative or `.alethic/`-relative, used verbatim in issues
  meta: NodeMeta | null;
  body: string;
  conflict: boolean;
  parseError?: string;
}

const posix = (p: string): string => p.replace(/\\/g, '/');

/** The rule/plan-step statement is everything before the first `## ` section; it must be non-empty. */
function statementOf(body: string): string {
  return (body.split(/^##\s/m)[0] ?? '').trim();
}

const PLACEHOLDER_STATEMENTS = new Set<string>(Object.values(PLACEHOLDER_CONTAINER_BODY));

/** `ensureContainers`' auto-created card text — real characters, but not a container's own thought. */
function isPlaceholderStatement(statement: string): boolean {
  return PLACEHOLDER_STATEMENTS.has(statement);
}

/** A `## Drift log` section with real content (HTML-comment placeholders don't count). */
function hasDriftLogEntry(body: string): boolean {
  const lines = body.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+Drift log\s*$/.test(l));
  if (idx < 0) return false;
  const section: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    section.push(lines[i]!);
  }
  return (
    section
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim().length > 0
  );
}

const slugFromLeafPath = (p: string): string => posix(p).replace(/^.*\//, '').replace(/\.md$/, '');
const slugFromContainerPath = (p: string): string => {
  const dir = posix(p).replace(/\/[^/]+$/, '');
  return dir.replace(/^.*\//, '');
};

/** Validate a set of loaded nodes (pure — no file IO). */
export function validateNodes(
  files: LoadedFile[],
  opts: { config?: Config; repoRoot?: string } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (
    level: IssueLevel,
    code: string,
    path: string,
    message: string,
    id?: string,
  ): void => {
    issues.push({ level, code, path: posix(path), message, ...(id !== undefined ? { id } : {}) });
  };

  const withMeta = files.filter((f): f is LoadedFile & { meta: NodeMeta } => f.meta !== null);
  const idToPath = new Map<string, string>();
  const allIds = new Set(withMeta.map((f) => f.meta.id));

  for (const f of files) {
    if (f.parseError) add('error', 'parse-error', f.path, f.parseError);
    if (f.conflict) add('warn', 'conflict', f.path, 'File contains git conflict markers');
  }

  for (const f of withMeta) {
    const { meta, path, body } = f;

    // duplicate id (error)
    const prev = idToPath.get(meta.id);
    if (prev)
      add('error', 'duplicate-id', path, `Duplicate id "${meta.id}" (also in ${prev})`, meta.id);
    else idToPath.set(meta.id, posix(path));

    // affects → existing id (error)
    if (meta.kind === 'rule') {
      for (const target of meta.affects) {
        if (!allIds.has(target))
          add(
            'error',
            'affects-missing',
            path,
            `affects references unknown id "${target}"`,
            meta.id,
          );
      }
    }

    // body statement present (error)
    if (meta.kind === 'rule' || meta.kind === 'plan-step') {
      if (statementOf(body).length === 0)
        add(
          'error',
          'no-statement',
          path,
          'Body has no statement/assertion before the first section',
          meta.id,
        );
    }

    // drift requires a Drift log entry (error, format-spec §1.2 invariant)
    if (meta.kind === 'rule' && meta.status === 'drift' && !hasDriftLogEntry(body)) {
      add(
        'error',
        'drift-no-log',
        path,
        'status is "drift" but there is no "## Drift log" entry',
        meta.id,
      );
    }

    // slug derived from title (warn)
    const expected = slugify(meta.title);
    if (meta.kind === 'root' || meta.kind === 'section') {
      // apex has no slug; a section's folder is fixed (`plans`/`domains`), not derived from its title
    } else if (
      meta.kind === 'domain' ||
      meta.kind === 'sub' ||
      meta.kind === 'plan' ||
      meta.kind === 'note'
    ) {
      if (expected && slugFromContainerPath(path) !== expected) {
        add(
          'warn',
          'slug-mismatch',
          path,
          `folder "${slugFromContainerPath(path)}" is not the slug of "${meta.title}" (${expected})`,
          meta.id,
        );
      }
    } else if (expected && slugFromLeafPath(path) !== expected) {
      add(
        'warn',
        'slug-mismatch',
        path,
        `file "${slugFromLeafPath(path)}" is not the slug of "${meta.title}" (${expected})`,
        meta.id,
      );
    }

    // title is a name, not an assertion (warn, decision 56). The tools reject this on the way in;
    // this catches what older scans and hand edits already left on disk.
    const titleIssue = titleNormViolation(meta.title);
    if (titleIssue) {
      add('warn', 'title-not-a-name', path, titleIssue, meta.id);
    }

    // a container whose card says nothing (warn, decision 56). A layer of 3–7 siblings has a roof
    // that summarizes them; a roof with an empty body is a folder name pretending to be a thought —
    // and so is `ensureContainers`' own auto-created placeholder, which is text but not a statement.
    if (
      (meta.kind === 'domain' || meta.kind === 'sub' || meta.kind === 'section') &&
      (statementOf(body).length === 0 || isPlaceholderStatement(statementOf(body)))
    ) {
      add(
        'warn',
        'container-without-statement',
        path,
        `"${meta.title}" has no statement — say what its children have in common, do not just name the folder`,
        meta.id,
      );
    }

    // rule without anchors and without tests (warn)
    if (meta.kind === 'rule' && meta.anchors.length === 0 && meta.tests.length === 0) {
      add('warn', 'no-anchors-no-tests', path, 'Rule has neither anchors nor tests', meta.id);
    }

    // broken anchor file (warn) — only when we can see the repo
    if ((meta.kind === 'rule' || meta.kind === 'plan-step') && opts.repoRoot) {
      for (const anchor of meta.anchors) {
        if (!existsSync(join(opts.repoRoot, posix(anchor.file)))) {
          add(
            'warn',
            'broken-anchor',
            path,
            `anchor file not found in repo: ${anchor.file}`,
            meta.id,
          );
        }
      }
    }
  }

  // width of containers (warn) — via the folder-derived tree
  const max = opts.config?.limits.max_rules_per_sub ?? 40;
  const entries: IndexEntry[] = withMeta.map((f) => ({ path: f.path, meta: f.meta }));
  const index = buildIndex(entries, () => '1970-01-01T00:00:00Z');
  for (const [parentId, children] of Object.entries(index.tree)) {
    const parentNode = index.nodes[parentId];
    if (parentNode?.kind !== 'sub' && parentNode?.kind !== 'domain') continue;
    // Too wide to read as one thought (decision 56) — the measure that replaced max_rules_per_sub.
    if (children.length > CONTAINER_MAX_CHILDREN) {
      add(
        'warn',
        'container-too-wide',
        parentNode.path,
        `${children.length} children under "${parentNode.title}" (norm: ≤ ${CONTAINER_MAX_CHILDREN}) — group them into a layer whose own card asserts something, or fold sentence-sized nodes into the feature they belong to`,
        parentId,
      );
    }
    // …and the format's own ceiling, kept for maps that set it deliberately.
    const ruleCount = children.filter((c) => index.nodes[c]?.kind === 'rule').length;
    if (parentNode.kind === 'sub' && ruleCount > max) {
      add(
        'warn',
        'too-many-rules',
        parentNode.path,
        `${ruleCount} rules exceed max_rules_per_sub (${max})`,
        parentId,
      );
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  return { issues, errors, warnings, ok: errors === 0 };
}

// ── directory loader + CLI-facing validate ─────────────────────────────────
/** Load and validate a `.alethic/` directory. `repoRoot` defaults to the directory's parent. */
export function validateDir(
  alethicDir: string,
  repoRoot: string = dirname(alethicDir),
): ValidationResult {
  const { nodes, config } = loadAlethicDir(alethicDir);
  const files: LoadedFile[] = nodes.map((n) => ({
    path: n.path,
    meta: n.meta,
    body: n.body,
    conflict: n.conflict,
    ...(n.parseError !== undefined ? { parseError: n.parseError } : {}),
  }));
  return validateNodes(files, { ...(config ? { config } : {}), repoRoot });
}
