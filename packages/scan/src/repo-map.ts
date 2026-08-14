// The repo-map: a deterministic, language-independent picture of the repository, built with zero
// tokens (packages/scan §5). It feeds the domain-decomposition call and the per-domain scans:
// a file tree with tree-sitter symbols, ecosystem manifests, domain candidates, and test mappings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSymbols, languageForFile } from '@alethic/format';
import { walkFiles } from './walk.js';
import { pnpmWorkspaceGlobs, readManifests, type Manifest } from './manifests.js';
import { domainCandidates, type DomainCandidate } from './domains.js';
import { isTestFile, mapTests, type TestMapping } from './tests.js';

export interface FileEntry {
  path: string;
  lang: string | null;
  symbols: string[]; // named top-level symbols (tree-sitter tags)
}

export interface RepoMap {
  root: string;
  files: FileEntry[];
  manifests: Manifest[];
  domains: DomainCandidate[];
  tests: TestMapping[];
}

/** Build the repo-map for a project root. Async because symbol extraction uses tree-sitter (WASM). */
export async function buildRepoMap(
  root: string,
  extraIgnores: readonly string[] = [],
): Promise<RepoMap> {
  const paths = walkFiles(root, extraIgnores);
  const files: FileEntry[] = [];
  for (const rel of paths) {
    const lang = languageForFile(rel);
    let symbols: string[] = [];
    if (lang && !isTestFile(rel)) {
      try {
        const extracted = await extractSymbols(rel, readFileSync(join(root, rel), 'utf8'));
        symbols = [
          ...new Set(extracted.map((s) => s.symbol).filter((s): s is string => Boolean(s))),
        ];
      } catch {
        symbols = [];
      }
    }
    files.push({ path: rel, lang, symbols });
  }
  return {
    root,
    files,
    manifests: readManifests(root, paths),
    domains: domainCandidates(paths, readManifests(root, paths), pnpmWorkspaceGlobs(root)),
    tests: mapTests(root, paths),
  };
}

/** A compact text digest of the repo-map for the decomposition prompt (keeps the call cheap). */
export function repoMapDigest(map: RepoMap): string {
  const lines: string[] = [];
  lines.push(`# Repo map: ${map.root}`);
  if (map.manifests.length) {
    lines.push('\n## Manifests');
    for (const m of map.manifests)
      lines.push(
        `- ${m.kind} ${m.path}${m.name ? ` (${m.name})` : ''}${m.units ? ` [${m.units.join(', ')}]` : ''}`,
      );
  }
  lines.push('\n## Domain candidates');
  for (const d of map.domains) lines.push(`- ${d.slug}: ${d.scope.join(', ')} (${d.source})`);
  lines.push('\n## Files');
  for (const f of map.files) {
    if (f.lang) lines.push(`- ${f.path}${f.symbols.length ? ` :: ${f.symbols.join(', ')}` : ''}`);
    else lines.push(`- ${f.path}`);
  }
  return lines.join('\n');
}
