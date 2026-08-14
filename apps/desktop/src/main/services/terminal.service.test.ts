import { describe, expect, it } from 'vitest';
import { TerminalService, type TermBackend, type BackendOptions } from './terminal.service';
import { ProcessService } from './process.service';
import { NotificationService } from './notification.service';

class FakeBackend implements TermBackend {
  pid = 4242;
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((c: number) => void)[] = [];
  constructor(readonly opts: BackendOptions) {}
  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
    this.exitCbs.forEach((cb) => cb(0));
  }
  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (c: number) => void): void {
    this.exitCbs.push(cb);
  }
  emit(d: string): void {
    this.dataCbs.forEach((cb) => cb(d));
  }
}

function makeService(): { term: TerminalService; backends: FakeBackend[] } {
  const backends: FakeBackend[] = [];
  const term = new TerminalService((opts) => {
    const b = new FakeBackend(opts);
    backends.push(b);
    return b;
  });
  term.setProject('/proj');
  return { term, backends };
}

describe('TerminalService', () => {
  it('creates a shell session with cwd = project and streams its output', () => {
    const { term, backends } = makeService();
    const data: Array<[string, string]> = [];
    term.onData((id, d) => data.push([id, d]));

    const s = term.create();
    expect(s.kind).toBe('shell');
    expect(s.cwd).toBe('/proj');
    expect(term.list()).toHaveLength(1);

    backends[0]!.emit('hello');
    expect(data).toContainEqual([s.id, 'hello']);
  });

  it('kill marks the session dead and stops the backend', () => {
    const { term, backends } = makeService();
    const s = term.create();
    term.kill(s.id);
    expect(backends[0]!.killed).toBe(true);
    expect(term.list().find((x) => x.id === s.id)?.alive).toBe(false);
  });

  it('feedExecutor creates a read-only Executor tab and pushes lines to it', () => {
    const { term } = makeService();
    const data: Array<[string, string]> = [];
    term.onData((id, d) => data.push([id, d]));
    term.feedExecutor('$ npm test');
    const exec = term.list().find((s) => s.kind === 'executor');
    expect(exec).toBeTruthy();
    expect(data[0]).toEqual([exec!.id, '$ npm test\r\n']);
  });

  it('killAll stops every live backend', () => {
    const { term, backends } = makeService();
    term.create();
    term.create();
    term.killAll();
    expect(backends.every((b) => b.killed)).toBe(true);
  });
});

describe('ProcessService (decision 46)', () => {
  it('lists only live shell processes and stops them', () => {
    const { term } = makeService();
    const procs = new ProcessService(term);
    const a = term.create();
    term.create();
    term.feedExecutor('x'); // the Executor tab is not a killable process
    expect(procs.runningCount()).toBe(2);
    expect(procs.list().some((p) => p.title === 'Executor')).toBe(false);

    procs.stop(a.id);
    expect(procs.runningCount()).toBe(1);
  });
});

describe('NotificationService (decision 50)', () => {
  it('stays silent while the window is focused', () => {
    const shown: string[] = [];
    const n = new NotificationService(
      () => true,
      (t) => shown.push(t),
    );
    expect(n.notify('Scan complete', 'ready')).toBe(false);
    expect(shown).toEqual([]);
  });

  it('notifies when the window is not focused', () => {
    const shown: string[] = [];
    const n = new NotificationService(
      () => false,
      (t) => shown.push(t),
    );
    expect(n.notify('Permission needed', 'Bash')).toBe(true);
    expect(shown).toEqual(['Permission needed']);
  });
});
