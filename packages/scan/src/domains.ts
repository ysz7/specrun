// Domain candidates from repo structure (decision 11 + 52): monorepo packages become domains
// automatically; otherwise the top-level source directories are the candidates. These are proposals
// the user confirms on the decomposition screen — the map's coverage starts here.
import { slugify } from '@alethic/format';
import type { Manifest } from './manifests.js';

export interface DomainCandidate {
  slug: string;
  title: string;
  scope: string[]; // glob(s) of the domain's code
  source: 'package' | 'directory';
}

const titleCase = (s: string): string =>
  s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Expand a `dir/*` workspace glob to the concrete package directories present in the tree. */
function expandGlob(glob: string, files: readonly string[]): string[] {
  if (glob.endsWith('/*')) {
    const base = glob.slice(0, -2);
    const dirs = new Set<string>();
    for (const f of files) {
      if (f.startsWith(`${base}/`)) {
        const rest = f.slice(base.length + 1);
        const seg = rest.split('/')[0];
        if (seg) dirs.add(`${base}/${seg}`);
      }
    }
    return [...dirs].sort();
  }
  // a concrete path
  return files.some((f) => f === glob || f.startsWith(`${glob}/`)) ? [glob] : [];
}

/** Immediate subdirectories of `parent` that contain files. */
function childDirs(parent: string, files: readonly string[]): string[] {
  const prefix = parent ? `${parent}/` : '';
  const dirs = new Set<string>();
  for (const f of files) {
    if (parent && !f.startsWith(prefix)) continue;
    const rest = parent ? f.slice(prefix.length) : f;
    if (rest.includes('/')) dirs.add(rest.split('/')[0]!);
  }
  return [...dirs].sort();
}

/**
 * Derive domain candidates. Monorepo (workspace globs) → one per package. Otherwise the immediate
 * subdirectories of `src/` (or the repo root) that hold code.
 */
export function domainCandidates(
  files: readonly string[],
  manifests: readonly Manifest[],
  workspaceGlobs: readonly string[],
): DomainCandidate[] {
  const npmWorkspaces = manifests.flatMap((m) => m.workspaces ?? []);
  const globs = [...new Set([...workspaceGlobs, ...npmWorkspaces])];

  if (globs.length > 0) {
    const out: DomainCandidate[] = [];
    for (const glob of globs) {
      for (const dir of expandGlob(glob, files)) {
        const name = dir.split('/').pop()!;
        out.push({
          slug: slugify(name),
          title: titleCase(name),
          scope: [`${dir}/**`],
          source: 'package',
        });
      }
    }
    return dedupe(out);
  }

  const srcRoot = childDirs('', files).includes('src') ? 'src' : '';
  const subs = childDirs(srcRoot, files).filter((d) => !d.startsWith('.'));
  return dedupe(
    subs.map((sub) => {
      const scopeDir = srcRoot ? `${srcRoot}/${sub}` : sub;
      return {
        slug: slugify(sub),
        title: titleCase(sub),
        scope: [`${scopeDir}/**`],
        source: 'directory' as const,
      };
    }),
  );
}

function dedupe(candidates: DomainCandidate[]): DomainCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => (seen.has(c.slug) ? false : (seen.add(c.slug), true)));
}
