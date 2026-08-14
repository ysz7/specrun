// GitPanelService — the left Git panel (planning-round decision): status, staged/unstaged, diffs,
// commit, push/pull, branch — via simple-git. Alethic NEVER commits on its own; every write here is
// a direct, explicit user action in the panel. Read-only helpers for sync/plan stay in GitService.
import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitFileDiff, GitStatus } from '@alethic/ipc';

export class GitPanelService {
  private root: string | null = null;

  setProject(root: string | null): void {
    this.root = root;
  }
  private git(): SimpleGit | null {
    return this.root ? simpleGit(this.root) : null;
  }

  async status(): Promise<GitStatus | null> {
    const g = this.git();
    if (!g) return null;
    try {
      if (!(await g.checkIsRepo())) return null;
      const s = await g.status();
      const staged = s.files.filter((f) => f.index !== ' ' && f.index !== '?').map((f) => f.path);
      const unstaged = s.files
        .filter((f) => f.working_dir !== ' ' && f.working_dir !== '?')
        .map((f) => f.path);
      return {
        branch: s.current ?? '(detached)',
        ahead: s.ahead,
        behind: s.behind,
        staged,
        unstaged,
        untracked: s.not_added,
        clean: s.isClean(),
      };
    } catch {
      return null;
    }
  }

  async stage(files: string[]): Promise<void> {
    await this.git()?.add(files);
  }
  async unstage(files: string[]): Promise<void> {
    await this.git()?.reset(['--', ...files]);
  }
  /** The one write that changes history — only ever from an explicit panel click. */
  async commit(message: string): Promise<void> {
    await this.git()?.commit(message);
  }
  async push(): Promise<void> {
    await this.git()?.push();
  }
  async pull(): Promise<void> {
    await this.git()?.pull();
  }

  async fileDiff(file: string, staged: boolean): Promise<GitFileDiff> {
    const g = this.git();
    if (!g) return { file, patch: '' };
    try {
      const args = staged ? ['--cached', '--', file] : ['--', file];
      return { file, patch: (await g.diff(args)).slice(0, 40000) };
    } catch {
      return { file, patch: '' };
    }
  }
}
