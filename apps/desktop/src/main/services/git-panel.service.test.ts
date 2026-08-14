import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitPanelService } from './git-panel.service';

const git = (cwd: string, ...args: string[]): void => {
  spawnSync('git', args, { cwd, stdio: 'ignore' });
};

describe('GitPanelService (simple-git panel)', () => {
  let tmp: string;
  let panel: GitPanelService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-git-'));
    git(tmp, 'init');
    git(tmp, 'config', 'user.email', 'test@example.com');
    git(tmp, 'config', 'user.name', 'Test');
    git(tmp, 'commit', '--allow-empty', '-m', 'root');
    panel = new GitPanelService();
    panel.setProject(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns null when the folder is not a repo', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'alethic-norepo-'));
    const p = new GitPanelService();
    p.setProject(nonRepo);
    expect(await p.status()).toBeNull();
    rmSync(nonRepo, { recursive: true, force: true });
  });

  it('reports untracked → staged → committed as the panel would drive it', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'hello');
    let s = await panel.status();
    expect(s?.branch).toBeTruthy();
    expect(s?.untracked).toContain('a.txt');
    expect(s?.clean).toBe(false);

    await panel.stage(['a.txt']);
    s = await panel.status();
    expect(s?.staged).toContain('a.txt');

    await panel.commit('add a.txt'); // the only history-changing write — always an explicit action
    s = await panel.status();
    expect(s?.clean).toBe(true);
  });

  it('produces a diff for a changed tracked file', async () => {
    writeFileSync(join(tmp, 'a.txt'), 'one\n');
    await panel.stage(['a.txt']);
    await panel.commit('add');
    writeFileSync(join(tmp, 'a.txt'), 'two\n');
    const diff = await panel.fileDiff('a.txt', false);
    expect(diff.patch).toContain('-one');
    expect(diff.patch).toContain('+two');
  });
});
