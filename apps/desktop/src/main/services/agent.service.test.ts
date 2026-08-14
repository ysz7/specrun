import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEngine, AgentEvent, AgentTask } from '@alethic/agent';
import type { AgentStreamMessage, PermissionRequest } from '@alethic/ipc';
import { AgentService } from './agent.service';

/** A fake engine: emits a text event, asks a permission via canUseTool, then finishes. */
class FakeEngine implements AgentEngine {
  lastTask: AgentTask | null = null;
  constructor(private readonly tool = 'Write') {}
  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    this.lastTask = task;
    yield { type: 'text', text: `hello from ${task.role}` };
    const decision = await task.canUseTool?.(this.tool, { file: 'x.ts' }, {} as never);
    yield { type: 'tool-result', name: this.tool, isError: decision?.behavior === 'deny' };
    yield { type: 'done', ok: true };
  }
}

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('AgentService', () => {
  let tmp: string;
  let engine: FakeEngine;
  let service: AgentService;
  let events: AgentStreamMessage[];
  let permits: PermissionRequest[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-agent-'));
    engine = new FakeEngine();
    service = new AgentService(engine, join(tmp, 'logs'));
    events = [];
    permits = [];
    service.onEvent((e) => events.push(e));
    service.onPermission((r) => permits.push(r));
    service.setProject(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('errors when no project is open', async () => {
    service.setProject(null);
    const { taskId } = service.send({ prompt: 'hi', model: 'claude-sonnet-5' });
    await nextTick();
    expect(events).toContainEqual({ taskId, type: 'error', message: 'No project is open.' });
  });

  // Phase 2 task 2: the diagnostics dump names the last error, not just versions.
  it('remembers the last error for diagnostics', async () => {
    expect(service.lastError()).toBeNull();
    service.setProject(null);
    service.send({ prompt: 'hi', model: 'claude-sonnet-5' });
    await nextTick();
    expect(service.lastError()).toMatchObject({ message: 'No project is open.' });
  });

  it('streams events, proxies a permission, and writes a JSONL log', async () => {
    const { taskId } = service.send({ prompt: 'scan', model: 'claude-sonnet-5', role: 'scanner' });
    // wait until the permission prompt arrives, then approve it
    for (let i = 0; i < 50 && permits.length === 0; i++) await nextTick();
    expect(permits[0]).toMatchObject({ taskId, toolName: 'Write' });
    service.respondPermission(permits[0]!.requestId, true);
    for (let i = 0; i < 50 && !events.some((e) => e.type === 'done'); i++) await nextTick();

    expect(engine.lastTask?.role).toBe('scanner');
    expect(events).toContainEqual({ taskId, type: 'text', text: 'hello from scanner' });
    expect(events).toContainEqual({ taskId, type: 'tool-result', name: 'Write', isError: false });
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true });

    const logs = service.listLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ taskId, role: 'scanner', model: 'claude-sonnet-5' });
    const lines = readFileSync(join(tmp, 'logs', readdirSync(join(tmp, 'logs'))[0]!), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(lines[0]!).kind).toBe('start');
  });

  // Decision 1: Yes / Yes-don't-ask-again-this-session / No. Dog-fooding (Phase 2) found the
  // prompt was unreachable at all; these pin the answer semantics now that it fires.
  describe('permission answers', () => {
    it('“don’t ask again this session” stops asking for that tool', async () => {
      const first = service.send({ prompt: 'a', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length === 0; i++) await nextTick();
      expect(permits).toHaveLength(1);
      service.respondPermission(permits[0]!.requestId, true, undefined, true); // remember
      expect(service.sessionGrants()).toMatchObject({ tools: ['Write'], autoAcceptEdits: false });

      // a second run asking for the same tool is not prompted again — and still succeeds
      const second = service.send({ prompt: 'b', model: 'claude-sonnet-5' });
      for (let i = 0; i < 100 && events.filter((e) => e.type === 'done').length < 2; i++)
        await nextTick();
      expect(permits).toHaveLength(1); // no new prompt
      expect(events).toContainEqual({
        taskId: second.taskId,
        type: 'tool-result',
        name: 'Write',
        isError: false, // allowed, not denied
      });
      expect(first.taskId).not.toBe(second.taskId);
    });

    it('a plain Allow does not grant the tool for later runs', async () => {
      service.send({ prompt: 'a', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length === 0; i++) await nextTick();
      service.respondPermission(permits[0]!.requestId, true); // once only
      expect(service.sessionGrants().tools).toEqual([]);

      service.send({ prompt: 'b', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length < 2; i++) await nextTick();
      expect(permits).toHaveLength(2); // asked again
    });

    it('opening another project forgets the session’s grants', async () => {
      service.send({ prompt: 'a', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length === 0; i++) await nextTick();
      service.respondPermission(permits[0]!.requestId, true, undefined, true);
      expect(service.sessionGrants().tools).toEqual(['Write']);

      service.setProject(tmp); // reopening / switching projects
      expect(service.sessionGrants().tools).toEqual([]);
    });

    it('a granted tool can be taken back, and asks again from the next call on', async () => {
      service.send({ prompt: 'a', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length === 0; i++) await nextTick();
      service.respondPermission(permits[0]!.requestId, true, undefined, true);
      expect(service.revokeGrant('Write').tools).toEqual([]);

      service.send({ prompt: 'b', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length < 2; i++) await nextTick();
      expect(permits).toHaveLength(2); // asked again
    });
  });

  // The other half of decision 1: the mode you switch on up front instead of reaching it by
  // clicking "Allow this session" on the first Write.
  describe('auto-accept edits', () => {
    it('lets an edit through unasked while it is on, and asks again once it is off', async () => {
      expect(service.setAutoAcceptEdits(true)).toMatchObject({ autoAcceptEdits: true, tools: [] });

      const run = service.send({ prompt: 'a', model: 'claude-sonnet-5' });
      for (let i = 0; i < 100 && !events.some((e) => e.type === 'done'); i++) await nextTick();
      expect(permits).toEqual([]); // never asked
      expect(events).toContainEqual({
        taskId: run.taskId,
        type: 'tool-result',
        name: 'Write',
        isError: false,
      });
      // …and it is a mode, not a grant: nothing was remembered per-tool.
      expect(service.sessionGrants().tools).toEqual([]);

      service.setAutoAcceptEdits(false);
      service.send({ prompt: 'b', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && permits.length === 0; i++) await nextTick();
      expect(permits).toHaveLength(1);
    });

    it('does not cover running a command — Bash still asks', async () => {
      const bash = new AgentService(new FakeEngine('Bash'), join(tmp, 'logs-bash'));
      const asked: PermissionRequest[] = [];
      bash.onPermission((r) => asked.push(r));
      bash.setProject(tmp);
      bash.setAutoAcceptEdits(true);

      bash.send({ prompt: 'a', model: 'claude-sonnet-5' });
      for (let i = 0; i < 50 && asked.length === 0; i++) await nextTick();
      expect(asked.map((r) => r.toolName)).toEqual(['Bash']);
    });

    it('opening another project turns the mode back off', () => {
      service.setAutoAcceptEdits(true);
      service.setProject(tmp);
      expect(service.sessionGrants().autoAcceptEdits).toBe(false);
    });
  });

  it('runs tasks sequentially (one slot)', async () => {
    const a = service.send({ prompt: 'first', model: 'claude-sonnet-5' });
    const b = service.send({ prompt: 'second', model: 'claude-sonnet-5' });
    // approve permissions as they arrive for both tasks
    for (let i = 0; i < 100 && events.filter((e) => e.type === 'done').length < 2; i++) {
      for (const p of permits.splice(0)) service.respondPermission(p.requestId, true);
      await nextTick();
    }
    const doneOrder = events.filter((e) => e.type === 'done').map((e) => e.taskId);
    expect(doneOrder).toEqual([a.taskId, b.taskId]);
  });

  // A Windows CI runner surfaced this: the temp log directory was removed while a run's write
  // stream was still opening, `createWriteStream` emitted EPERM, nothing was listening, and Node
  // turned it into an uncaught exception — failing the suite even though every run had succeeded.
  // Losing the log is acceptable; losing the process because of the log is not.
  it('a run survives a log directory it cannot write to (logging is bookkeeping)', async () => {
    const logs = join(tmp, 'logs');
    // The directory exists when the service is constructed and is gone by the time a run opens
    // its file — exactly the race the runner hit.
    rmSync(logs, { recursive: true, force: true });

    const task = service.send({ prompt: 'write something', model: 'claude-sonnet-5' });
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'done'); i++) {
      for (const p of permits.splice(0)) service.respondPermission(p.requestId, true);
      await nextTick();
    }

    const done = events.find((e) => e.type === 'done');
    expect(done?.taskId).toBe(task.taskId); // the run finished on its own terms
    expect(events.some((e) => e.type === 'error')).toBe(false); // and reported no error to the user
  });
});
