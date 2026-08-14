// AgentService — owns the SDK sessions: a sequential task queue (one agent run at a time,
// decision 25), a permission proxy (SDK canUseTool → renderer → answer, like Claude Code), and a
// JSONL log per run (decision 13). Emits normalized events; main wires them to the IPC stream.
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDIT_TOOLS } from '@alethic/agent';
import type { AgentEngine, AgentRole, CanUseTool } from '@alethic/agent';
import type {
  AgentStreamMessage,
  PermissionRequest,
  RunLogContent,
  RunLogEntry,
  SessionGrants,
} from '@alethic/ipc';

type EventListener = (message: AgentStreamMessage) => void;
type PermissionListener = (request: PermissionRequest) => void;
type PermissionResolver = (
  result: { behavior: 'allow' } | { behavior: 'deny'; message: string },
) => void;
/** A prompt awaiting the user, kept with its tool so a "don't ask again" answer knows what to grant. */
interface PendingPermission {
  resolve: PermissionResolver;
  toolName: string;
}

const ROLES = new Set<AgentRole>([
  'scanner',
  'sync',
  'planner',
  'executor',
  'navigator',
  'plan-author',
]);

export class AgentService {
  private cwd: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private running: string | null = null; // the task currently executing (for immediate UI feedback)
  private readonly aborts = new Map<string, AbortController>();
  private readonly pending = new Map<string, PendingPermission>();
  // "Yes, don't ask again this session" (decision 1): tools the user has blanket-approved for this
  // project. Reset when the project changes — a grant is scoped to the work the user was watching.
  private readonly granted = new Set<string>();
  // The other half of decision 1: auto-accept edits as a mode you can switch on ahead of time,
  // instead of reaching it by clicking "Allow this session" on the first Write. Covers file edits
  // only — a command still asks. Session-scoped like the grants above, for the same reason.
  private autoAcceptEdits = false;
  private emitEvent: EventListener = () => {};
  private askPermission: PermissionListener = () => {};
  // The most recent agent-run error, for the diagnostics dump (Phase 2 task 2) — a bug report is
  // more actionable with the failure that prompted it than with versions alone.
  private lastRunError: { ts: string; message: string } | null = null;

  /** Every event goes through here so an `error` is remembered for diagnostics before it streams out. */
  private emit(message: AgentStreamMessage): void {
    if (message.type === 'error') {
      this.lastRunError = { ts: new Date().toISOString(), message: message.message };
    }
    this.emitEvent(message);
  }

  /** The last agent-run error seen, or null if none yet this session. */
  lastError(): { ts: string; message: string } | null {
    return this.lastRunError;
  }

  constructor(
    private readonly engine: AgentEngine,
    private readonly logsDir: string,
  ) {
    mkdirSync(logsDir, { recursive: true });
  }

  onEvent(listener: EventListener): void {
    this.emitEvent = listener;
  }
  onPermission(listener: PermissionListener): void {
    this.askPermission = listener;
  }
  setProject(cwd: string | null): void {
    this.cwd = cwd;
    this.granted.clear();
    this.autoAcceptEdits = false;
  }

  /** What runs without asking right now, so the UI can show it — and take it back (decision 1). */
  sessionGrants(): SessionGrants {
    return {
      tools: [...this.granted],
      autoAcceptEdits: this.autoAcceptEdits,
      editTools: [...EDIT_TOOLS],
    };
  }

  /** Turn auto-accept-edits on or off up front. Returns the new state, so the UI never guesses. */
  setAutoAcceptEdits(enabled: boolean): SessionGrants {
    this.autoAcceptEdits = enabled;
    return this.sessionGrants();
  }

  /** Take back one "Allow this session" grant — the tool asks again from the next call on. */
  revokeGrant(tool: string): SessionGrants {
    this.granted.delete(tool);
    return this.sessionGrants();
  }

  /** Enqueue a task; returns its id immediately. Runs sequentially. */
  send(input: { prompt: string; model: string; role?: string | undefined }): { taskId: string } {
    const taskId = randomUUID();
    const cwd = this.cwd;
    if (!cwd) {
      queueMicrotask(() => this.emit({ taskId, type: 'error', message: 'No project is open.' }));
      return { taskId };
    }
    const role = (
      input.role && ROLES.has(input.role as AgentRole) ? input.role : 'navigator'
    ) as AgentRole;
    this.queue = this.queue.then(() => this.run(taskId, input.prompt, input.model, role, cwd));
    return { taskId };
  }

  cancel(taskId: string): void {
    this.aborts.get(taskId)?.abort();
  }

  /** The task currently running, if any — lets a late-mounting chat panel show "working" at once. */
  activeTask(): { taskId: string | null } {
    return { taskId: this.running };
  }

  /**
   * Answer a permission prompt (decision 1). `remember` is the "don't ask again this session"
   * option: it approves this tool for the rest of the session, which is also how the auto-accept-
   * edits mode is reached — one click on the first Write.
   */
  respondPermission(requestId: string, allow: boolean, message?: string, remember?: boolean): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    if (allow && remember) this.granted.add(request.toolName);
    request.resolve(
      allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: message ?? 'Denied by the user' },
    );
  }

  listLogs(): RunLogEntry[] {
    const out: RunLogEntry[] = [];
    for (const file of readdirSync(this.logsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const first = readFileSync(join(this.logsDir, file), 'utf8').split('\n')[0]!;
        const o = JSON.parse(first) as { taskId: string; role: string; model: string; ts: string };
        out.push({ file, taskId: o.taskId, role: o.role, model: o.model, startedAt: o.ts });
      } catch {
        /* skip a malformed log */
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Read one run log's raw JSONL, for the viewer (decision 13). Guards against path traversal. */
  readLog(file: string): RunLogContent | null {
    if (!/^[\w.-]+\.jsonl$/.test(file)) return null; // filename only, no separators
    try {
      return { file, text: readFileSync(join(this.logsDir, file), 'utf8') };
    } catch {
      return null;
    }
  }

  private async run(
    taskId: string,
    prompt: string,
    model: string,
    role: AgentRole,
    cwd: string,
  ): Promise<void> {
    const abortController = new AbortController();
    this.aborts.set(taskId, abortController);
    this.running = taskId;
    // The run log is bookkeeping and must never take the run — or the process — down with it.
    // `createWriteStream` opens the file asynchronously, so a failure arrives as an `error` event;
    // with nothing listening, Node re-throws it as an uncaught exception and the whole app dies
    // because a log line could not be written. A directory that vanished, a full disk, an
    // antivirus holding the handle: all of them are reasons to lose the log, none is a reason to
    // lose the work. Found on a Windows CI runner as `EPERM` when the temp log directory went away
    // mid-run (the run itself had already succeeded).
    const log = createWriteStream(join(this.logsDir, `${taskId}.jsonl`), { flags: 'a' });
    let logging = true;
    log.on('error', () => {
      logging = false;
    });
    const record = (obj: unknown): void => {
      if (!logging) return;
      try {
        log.write(`${JSON.stringify(obj)}\n`);
      } catch {
        logging = false;
      }
    };
    record({ ts: new Date().toISOString(), kind: 'start', taskId, role, model, cwd });
    // Immediate "work started" signal so the chat shows a working state before the first token
    // (SDK subprocess startup can take a few seconds).
    this.emit({ taskId, type: 'started' });

    try {
      for await (const event of this.engine.run({
        role,
        model,
        prompt,
        cwd,
        abortController,
        canUseTool: this.makeCanUseTool(taskId),
      })) {
        this.emit({ taskId, ...event });
        // `usage` streams many times a second for the live counter — keep it out of the run log.
        if (event.type !== 'usage')
          record({ ts: new Date().toISOString(), kind: 'event', ...event });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ taskId, type: 'error', message });
      record({ ts: new Date().toISOString(), kind: 'error', message });
    } finally {
      this.aborts.delete(taskId);
      if (this.running === taskId) this.running = null;
      log.end();
    }
  }

  /** Proxy a permission prompt to the renderer and await the user's decision (decision 1). */
  private makeCanUseTool(taskId: string): CanUseTool {
    return (toolName, input) => {
      if (this.granted.has(toolName) || (this.autoAcceptEdits && EDIT_TOOLS.includes(toolName)))
        return Promise.resolve({ behavior: 'allow' as const });
      return new Promise((resolve) => {
        const requestId = randomUUID();
        this.pending.set(requestId, { resolve, toolName });
        this.askPermission({ requestId, taskId, toolName, input });
      });
    };
  }
}
