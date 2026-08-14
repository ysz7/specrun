// ProcessService — the long-lived-process manager (decision 46). Terminal shell sessions are the
// processes we can see and kill (a `npm run dev` started in a tab); this is a thin, testable view
// over TerminalService so the status bar can show a count and the user can Stop one, and so closing
// a project can offer to stop anything still running.
import type { ProcessInfo } from '@alethic/ipc';
import type { TerminalService } from './terminal.service';

export class ProcessService {
  constructor(private readonly terminal: TerminalService) {}

  /** Live shell-backed processes (the Executor read-only stream is not a killable process). */
  list(): ProcessInfo[] {
    return this.terminal
      .list()
      .filter((s) => s.kind === 'shell' && s.alive)
      .map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, pid: s.pid }));
  }

  stop(id: string): void {
    this.terminal.kill(id);
  }

  runningCount(): number {
    return this.list().length;
  }
}
