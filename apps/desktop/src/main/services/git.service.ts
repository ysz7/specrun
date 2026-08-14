// GitService — the "what changed since I last looked" oracle for the drift check (Phase 7 task 1).
// It answers with repo-relative paths from `git diff` + the working tree, and degrades to an
// mtime comparison when the project is not a git repo. Deliberately Electron-free and injectable
// (the git runner is a constructor arg) so it can be unit-tested without a real repository.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ChangedFiles {
  /** Repo-relative posix paths that were added, modified or renamed-into. */
  files: string[];
  /** Repo-relative posix paths that were deleted. */
  deleted: string[];
}

/** Runs a git command in `cwd`, returning stdout; throws on non-zero exit. */
export type GitRunner = (cwd: string, args: string[]) => string;

const defaultRunner: GitRunner = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const toPosix = (p: string): string => p.split(sep).join('/');

export class GitService {
  constructor(private readonly run: GitRunner = defaultRunner) {}

  /** True when `root` is inside a git work tree. */
  isRepo(root: string): boolean {
    try {
      return this.run(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    } catch {
      return false;
    }
  }

  /** The current HEAD commit, or null (no repo / no commits yet). */
  head(root: string): string | null {
    try {
      return this.run(root, ['rev-parse', 'HEAD']).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Everything that changed since `since` (a commit) plus the current working tree. When `since`
   * is null (first sync) only the working tree is considered. Returns null when there is no repo —
   * the caller then falls back to {@link changedByMtime}.
   */
  changedSince(root: string, since: string | null): ChangedFiles | null {
    if (!this.isRepo(root)) return null;
    const files = new Set<string>();
    const deleted = new Set<string>();

    const absorb = (nameStatus: string): void => {
      for (const line of nameStatus.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0] ?? '';
        if (code.startsWith('D')) {
          if (parts[1]) deleted.add(toPosix(parts[1]));
        } else if (code.startsWith('R')) {
          // rename: old path is gone, new path (last column) is the live one
          if (parts[1]) deleted.add(toPosix(parts[1]));
          const dest = parts[parts.length - 1];
          if (dest) files.add(toPosix(dest));
        } else if (parts[1]) {
          files.add(toPosix(parts[1]));
        }
      }
    };

    try {
      if (since) absorb(this.run(root, ['diff', '--name-status', `${since}..HEAD`]));
    } catch {
      /* `since` may be an unknown commit (history rewritten) — ignore, the working tree still counts */
    }
    try {
      absorb(this.run(root, ['diff', '--name-status', 'HEAD']));
    } catch {
      /* no commits yet */
    }
    try {
      // untracked files, one path per line
      const untracked = this.run(root, ['ls-files', '--others', '--exclude-standard']);
      for (const line of untracked.split('\n')) if (line.trim()) files.add(toPosix(line.trim()));
    } catch {
      /* ignore */
    }

    // A path both deleted and re-added (rename churn) counts as present.
    for (const f of files) deleted.delete(f);
    return { files: [...files], deleted: [...deleted] };
  }

  /**
   * Fallback for non-git projects: of the given candidate paths (the map's anchored files), those
   * whose mtime is newer than `since`. Repo-relative posix paths in, repo-relative posix paths out.
   */
  changedByMtime(root: string, candidates: readonly string[], since: string | null): ChangedFiles {
    const cutoff = since ? Date.parse(since) : 0;
    const files: string[] = [];
    const deleted: string[] = [];
    for (const rel of candidates) {
      try {
        const mtime = statSync(join(root, rel)).mtimeMs;
        if (!since || mtime > cutoff) files.push(rel);
      } catch {
        deleted.push(rel); // candidate file no longer on disk
      }
    }
    return { files, deleted };
  }

  /** The old content of a file at a commit (for the Sync agent's before/after), or null. */
  showAt(root: string, commit: string, file: string): string | null {
    try {
      return this.run(root, ['show', `${commit}:${file}`]);
    } catch {
      return null;
    }
  }

  /** A unified diff for the given files since `since` + working tree (context for the Sync agent). */
  diff(root: string, since: string | null, files: readonly string[]): string {
    if (files.length === 0 || !this.isRepo(root)) return '';
    const range = since ? [`${since}`] : [];
    try {
      return this.run(root, ['diff', ...range, '--', ...files.map((f) => toPosix(f))]).slice(
        0,
        6000,
      );
    } catch {
      return '';
    }
  }
}

/** Utility used by callers to make a repo-relative posix path from an absolute one. */
export const repoRelative = (root: string, abs: string): string => toPosix(relative(root, abs));
