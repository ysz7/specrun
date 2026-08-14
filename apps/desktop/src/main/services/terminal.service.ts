// TerminalService — the bottom terminal drawer (decision 45): xterm.js in the renderer, backed here
// by node-pty when its native binding is available, else a child_process shell fallback (same wire
// protocol, so the renderer never knows the difference). Tabs are sessions with cwd = the project.
// A special read-only "Executor" session streams the agent's bash-tool output so everything that
// touches the system is visible in one place.
import { spawn as cpSpawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

/** The minimal backend both node-pty and child_process are adapted to. */
export interface TermBackend {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export interface BackendOptions {
  cwd: string;
  cols: number;
  rows: number;
}
export type BackendFactory = (opts: BackendOptions) => TermBackend;

/** The slice of node-pty's surface we use (typed locally so the optional dep never leaks into the build). */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
  ): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (e: { exitCode: number }) => void): void;
  };
}

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  kind: 'shell' | 'executor';
  pid: number;
  alive: boolean;
}

type DataListener = (id: string, data: string) => void;
type ExitListener = (id: string, code: number) => void;

const isWin = process.platform === 'win32';

export class TerminalService {
  private readonly sessions = new Map<string, { meta: TerminalSession; backend?: TermBackend }>();
  private seq = 0;
  private root: string | null = null;
  private onDataCb: DataListener = () => {};
  private onExitCb: ExitListener = () => {};

  constructor(private readonly makeBackend: BackendFactory = defaultBackendFactory()) {}

  setProject(root: string | null): void {
    this.root = root;
  }
  onData(cb: DataListener): void {
    this.onDataCb = cb;
  }
  onExit(cb: ExitListener): void {
    this.onExitCb = cb;
  }

  /** Open a new shell session (cwd = project root). */
  create(cwd?: string): TerminalSession {
    const id = `t${++this.seq}`;
    const dir = cwd ?? this.root ?? process.cwd();
    const backend = this.makeBackend({ cwd: dir, cols: 80, rows: 24 });
    const meta: TerminalSession = {
      id,
      title: `Terminal ${this.seq}`,
      cwd: dir,
      kind: 'shell',
      pid: backend.pid,
      alive: true,
    };
    backend.onData((d) => this.onDataCb(id, d));
    backend.onExit((code) => {
      const s = this.sessions.get(id);
      if (s) s.meta.alive = false;
      this.onExitCb(id, code);
    });
    this.sessions.set(id, { meta, backend });
    return meta;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.backend?.write(data);
  }
  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.backend?.resize(cols, rows);
  }
  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.backend?.kill();
    s.meta.alive = false;
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((s) => s.meta);
  }

  // ── executor read-only stream ──────────────────────────────────────────────

  /** Ensure the read-only Executor tab exists and return its id. */
  ensureExecutorTab(): string {
    const existing = [...this.sessions.values()].find((s) => s.meta.kind === 'executor');
    if (existing) return existing.meta.id;
    const id = 'exec';
    this.sessions.set(id, {
      meta: { id, title: 'Executor', cwd: this.root ?? '', kind: 'executor', pid: 0, alive: true },
    });
    return id;
  }

  /** Push a line into the read-only Executor tab (the agent's bash tool output). */
  feedExecutor(text: string): void {
    const id = this.ensureExecutorTab();
    this.onDataCb(id, text.endsWith('\n') ? text : `${text}\r\n`);
  }

  /** Kill every live shell backend (project close / app quit). */
  killAll(): void {
    for (const [id] of this.sessions) this.kill(id);
  }
}

// ── backends ─────────────────────────────────────────────────────────────────

/** Try node-pty; if its native binding can't load, fall back to a piped child_process shell. */
export function defaultBackendFactory(): BackendFactory {
  let pty: NodePtyModule | null = null;
  try {
    const require = createRequire(import.meta.url);
    pty = require('node-pty') as NodePtyModule;
    // touch the binding so a broken/absent native build fails here, not later → child fallback
    if (typeof pty.spawn !== 'function') pty = null;
  } catch {
    pty = null;
  }
  return pty ? (opts) => ptyBackend(pty!, opts) : (opts) => childBackend(opts);
}

function shell(): string {
  return isWin ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/bash');
}

function ptyBackend(pty: NodePtyModule, opts: BackendOptions): TermBackend {
  const p = pty.spawn(shell(), [], {
    name: 'xterm-color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: process.env as Record<string, string>,
  });
  return {
    pid: p.pid,
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(({ exitCode }) => cb(exitCode)),
  };
}

function childBackend(opts: BackendOptions): TermBackend {
  const child: ChildProcess = cpSpawn(shell(), [], {
    cwd: opts.cwd,
    env: process.env,
    stdio: 'pipe',
  });
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((c: number) => void)[] = [];
  child.stdout?.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d.toString())));
  child.stderr?.on('data', (d: Buffer) => dataCbs.forEach((cb) => cb(d.toString())));
  child.on('exit', (code) => exitCbs.forEach((cb) => cb(code ?? 0)));
  return {
    pid: child.pid ?? 0,
    write: (d) => child.stdin?.write(d),
    resize: () => {}, // no PTY: resize is a no-op
    kill: () => killTree(child),
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
}

/** Kill the process and its children (a dev server spawns node grandchildren). */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}
