// Ecosystem-manifest detection (decision 52): package.json, go.mod, requirements.txt / pyproject,
// Cargo.toml, pom.xml, docker-compose, Dockerfile. These are language-independent hints for domain
// decomposition — not rules, just structure.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type ManifestKind = 'npm' | 'go' | 'python' | 'cargo' | 'maven' | 'compose' | 'dockerfile';

export interface Manifest {
  kind: ManifestKind;
  path: string; // posix, relative to root
  name?: string;
  workspaces?: string[]; // npm workspace globs
  units?: string[]; // e.g. compose service names
}

const MANIFEST_BASENAMES: Record<string, ManifestKind> = {
  'package.json': 'npm',
  'go.mod': 'go',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'Cargo.toml': 'cargo',
  'pom.xml': 'maven',
  'docker-compose.yml': 'compose',
  'docker-compose.yaml': 'compose',
  'compose.yml': 'compose',
  Dockerfile: 'dockerfile',
};

function tomlName(text: string): string | undefined {
  // crude: the `name = "..."` under a [package] / [project] header
  const match = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return match?.[1];
}

/** Parse one manifest file into a {@link Manifest}, or undefined if it isn't one. */
export function readManifest(root: string, relPath: string): Manifest | undefined {
  const kind = MANIFEST_BASENAMES[basename(relPath)];
  if (!kind) return undefined;
  const abs = join(root, relPath);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
  const base: Manifest = { kind, path: relPath };
  try {
    switch (kind) {
      case 'npm': {
        const pkg = JSON.parse(text) as {
          name?: string;
          workspaces?: string[] | { packages?: string[] };
        };
        return {
          ...base,
          ...(pkg.name ? { name: pkg.name } : {}),
          ...(pkg.workspaces
            ? {
                workspaces: Array.isArray(pkg.workspaces)
                  ? pkg.workspaces
                  : (pkg.workspaces.packages ?? []),
              }
            : {}),
        };
      }
      case 'go': {
        const m = text.match(/^module\s+(\S+)/m);
        return { ...base, ...(m ? { name: m[1] } : {}) };
      }
      case 'python': {
        const name = tomlName(text);
        return { ...base, ...(name ? { name } : {}) };
      }
      case 'cargo': {
        const name = tomlName(text);
        return { ...base, ...(name ? { name } : {}) };
      }
      case 'maven': {
        const m = text.match(/<artifactId>([^<]+)<\/artifactId>/);
        return { ...base, ...(m ? { name: m[1] } : {}) };
      }
      case 'compose': {
        const doc = parseYaml(text) as { services?: Record<string, unknown> } | null;
        const units = doc?.services ? Object.keys(doc.services) : [];
        return { ...base, units };
      }
      case 'dockerfile':
        return base;
    }
  } catch {
    return base;
  }
  return base;
}

/** Find and parse every ecosystem manifest in a file list. */
export function readManifests(root: string, files: readonly string[]): Manifest[] {
  const out: Manifest[] = [];
  for (const rel of files) {
    const manifest = readManifest(root, rel);
    if (manifest) out.push(manifest);
  }
  return out;
}

/** pnpm workspace package globs (a monorepo signal, decision 11). */
export function pnpmWorkspaceGlobs(root: string): string[] {
  try {
    const doc = parseYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages?: string[];
    } | null;
    return doc?.packages ?? [];
  } catch {
    return [];
  }
}
