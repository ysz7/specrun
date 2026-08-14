import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, type GitRunner } from './git.service';

describe('GitService.changedSince', () => {
  it('unions committed diff, working-tree diff and untracked files; classifies deletes/renames', () => {
    const runner: GitRunner = (_cwd, args) => {
      if (args[0] === 'rev-parse') return 'true';
      if (args[0] === 'ls-files') return 'brand/new.ts\n';
      if (args[0] === 'diff' && args[2]?.includes('..HEAD'))
        return 'M\tsrc/a.ts\nD\tsrc/gone.ts\nR100\tsrc/old.ts\tsrc/renamed.ts\n';
      if (args[0] === 'diff') return 'M\tsrc/b.ts\n';
      throw new Error('unexpected');
    };
    const changed = new GitService(runner).changedSince('/repo', 'abc123');
    expect(changed).not.toBeNull();
    expect(changed!.files.sort()).toEqual(
      ['brand/new.ts', 'src/a.ts', 'src/b.ts', 'src/renamed.ts'].sort(),
    );
    expect(changed!.deleted.sort()).toEqual(['src/gone.ts', 'src/old.ts'].sort());
  });

  it('returns null when the folder is not a git repo', () => {
    const git = new GitService(() => {
      throw new Error('not a repo');
    });
    expect(git.changedSince('/repo', null)).toBeNull();
    expect(git.isRepo('/repo')).toBe(false);
    expect(git.head('/repo')).toBeNull();
  });
});

describe('GitService.changedByMtime (no-git fallback)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-git-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns candidates newer than the cutoff and flags missing ones as deleted', () => {
    writeFileSync(join(tmp, 'a.ts'), 'x');
    const git = new GitService();
    const past = new Date(Date.now() - 60_000).toISOString();
    const changed = git.changedByMtime(tmp, ['a.ts', 'missing.ts'], past);
    expect(changed.files).toContain('a.ts');
    expect(changed.deleted).toContain('missing.ts');
  });

  it('treats every candidate as changed on the first sync (no cutoff)', () => {
    writeFileSync(join(tmp, 'a.ts'), 'x');
    const git = new GitService();
    const changed = git.changedByMtime(tmp, ['a.ts'], null);
    expect(changed.files).toEqual(['a.ts']);
  });
});
