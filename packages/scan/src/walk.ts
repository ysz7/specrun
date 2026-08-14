// Deterministic file walk (no LLM). Skips the usual noise and anything under .alethic/, so the
// repo-map reflects the source, not the tooling.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.alethic',
  '.vite',
  '.turbo',
  '.next',
  '__pycache__',
  'target',
  'vendor',
]);

const toPosix = (p: string): string => p.split(sep).join('/');

/** All files under `root`, as posix paths relative to `root`, deterministically ordered. */
export function walkFiles(root: string, extraIgnores: readonly string[] = []): string[] {
  const ignore = new Set([...IGNORED_DIRS, ...extraIgnores]);
  const out: string[] = [];
  const recur = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!ignore.has(name)) recur(full);
      } else {
        out.push(toPosix(relative(root, full)));
      }
    }
  };
  recur(root);
  return out.sort();
}
