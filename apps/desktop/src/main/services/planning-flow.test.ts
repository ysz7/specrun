// Integration tests for the planning flows (dev-planning v2, decision 55) — AgentService +
// PlanService composed exactly as main/index.ts composes them, driven by a scripted fake engine
// instead of the SDK. Deterministic: the "agent" writes through the same SpecStore the MCP tools
// use, so these exercise the real finalization (checkbox ticking, phase notes, the code-map pass)
// end to end, including the queue and Stop.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAlethicDir, parsePlanPhases } from '@alethic/format';
import {
  SpecStore,
  type AgentEngine,
  type AgentEvent,
  type AgentRole,
  type AgentTask,
} from '@alethic/agent';
import type { AgentStreamMessage, PlanProgress } from '@alethic/ipc';
import { AgentService } from './agent.service';
import { PlanService } from './plan.service';
import { PlanningFlow } from './planning-flow';
import { GitService, type GitRunner } from './git.service';

const CLOCK = '2026-07-30T00:00:00Z';
const MODEL = 'claude-opus-5';
const PLAN_ID = 'p-000001';
const PLAN_BODY = [
  'Ship the fee.',
  '',
  '## Phase 1 — Skeleton',
  '- [ ] Add the fee module',
  '- [ ] Test it',
  '',
  '## Phase 2 — Wire it up',
  '- [ ] Call it from checkout',
].join('\n');

/**
 * A fake engine: records the runs, performs each role's scripted spec writes (standing in for its
 * MCP tool calls), and can hold a role's run open until the test releases it — or until the run is
 * aborted, which is what the Stop button does.
 */
class ScriptedEngine implements AgentEngine {
  readonly runs: AgentTask[] = [];
  readonly script: Partial<Record<AgentRole, (task: AgentTask) => void | Promise<void>>> = {};
  readonly held = new Set<AgentRole>();
  private readonly releases: (() => void)[] = [];

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    this.runs.push(task);
    yield { type: 'text', text: `[${task.role}] working` };
    if (this.held.has(task.role)) {
      const aborted = await new Promise<boolean>((resolve) => {
        this.releases.push(() => resolve(false));
        task.abortController?.signal.addEventListener('abort', () => resolve(true));
      });
      if (aborted) {
        yield { type: 'error', message: 'Aborted by the user' };
        return;
      }
    }
    await this.script[task.role]?.(task);
    yield { type: 'done', ok: true };
  }

  /** Let every held run continue (and any future one run straight through). */
  releaseAll(): void {
    this.held.clear();
    for (const release of this.releases.splice(0)) release();
  }
}

describe('planning flows on a fake engine', () => {
  let tmp: string;
  let engine: ScriptedEngine;
  let agent: AgentService;
  let plan: PlanService;
  let flow: PlanningFlow;
  let progress: PlanProgress[];
  let events: AgentStreamMessage[];
  let untracked: string[]; // what "git" reports as new — the files a phase wrote

  /** Only the calls PlanService makes: is-repo, HEAD, diffs, untracked files. */
  const gitRunner: GitRunner = (_cwd, args) => {
    if (args[0] === 'rev-parse') return args[1] === '--is-inside-work-tree' ? 'true\n' : 'c0ffee\n';
    if (args[0] === 'ls-files') return untracked.join('\n');
    return '';
  };

  const write = (rel: string, text: string): void => {
    mkdirSync(join(tmp, dirname(rel)), { recursive: true });
    writeFileSync(join(tmp, rel), text, 'utf8');
    untracked.push(rel);
  };

  const store = (root = tmp): SpecStore => new SpecStore(join(root, '.alethic'), () => CLOCK);
  const nodes = (root = tmp): ReturnType<typeof loadAlethicDir>['nodes'] =>
    loadAlethicDir(join(root, '.alethic')).nodes;
  const planBody = (): string => nodes().find((n) => n.meta?.id === PLAN_ID)!.body;

  /** Run the microtask/timer queue until `done()` holds (the agent queue is promise-driven). */
  const settle = async (done: () => boolean = () => false, ticks = 400): Promise<void> => {
    for (let i = 0; i < ticks; i++) {
      if (done()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  const idle = (): boolean =>
    agent.activeTask().taskId === null &&
    events.some((e) => e.type === 'done' || e.type === 'error');

  const open = (root: string): void => {
    plan.setProject(root);
    agent.setProject(root);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-flow-'));
    untracked = [];
    engine = new ScriptedEngine();
    agent = new AgentService(engine, join(tmp, 'logs'));
    plan = new PlanService(new GitService(gitRunner), () => CLOCK);
    flow = new PlanningFlow(agent, plan);
    progress = [];
    events = [];
    plan.onProgress((p) => progress.push(p));
    agent.onEvent((e) => {
      events.push(e);
      flow.handleAgentEvent(e); // exactly what the composition root does
    });

    // A dev project with a map root and the single living plan document (decision 55).
    open(tmp);
    plan.ensureRoot('dev');
    store().upsertPlan({
      id: PLAN_ID,
      slug: 'roadmap',
      title: 'Ship the fee',
      goal: 'Add a service fee',
      body: PLAN_BODY,
    });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('plan mode: the Plan Author fills the map with notes (decision 54)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'alethic-plan-mode-'));
    open(empty);
    engine.script['plan-author'] = (task) => {
      const s = new SpecStore(join(task.cwd, '.alethic'), () => CLOCK);
      s.setThesis('Three days in Lviv, walkable, coffee-led.');
      const day = s.upsertNote({
        title: 'Day 1',
        body: 'Arrive at 09:40, drop bags, Rynok square.',
      });
      s.upsertNote({
        title: 'Lunch',
        body: 'Baczewski, 13:00 — order the varenyky.',
        parent: day.id,
      });
    };

    const started = flow.startBuilding('a three-day trip to Lviv', MODEL, 'plan');
    await settle(idle);

    expect(started).toMatchObject({ started: true });
    expect(engine.runs.map((r) => r.role)).toEqual(['plan-author']);
    const written = nodes(empty);
    expect(
      written
        .filter((n) => n.meta?.kind === 'note')
        .map((n) => n.meta!.title)
        .sort(),
    ).toEqual(['Day 1', 'Lunch']);
    // real content, nested under its section, and the thesis on the apex
    expect(written.find((n) => n.meta?.title === 'Lunch')!.body).toContain('varenyky');
    expect(written.find((n) => n.meta?.title === 'Lunch')!.path).toContain('day-1/');
    expect(written.find((n) => n.meta?.kind === 'root')!.body).toContain('Three days in Lviv');
    expect(readFileSync(join(empty, '.alethic', 'config.yaml'), 'utf8')).toContain('mode: plan');
    rmSync(empty, { recursive: true, force: true });
  });

  it('a phase runs, ticks its checkboxes, and its code lands in the map', async () => {
    engine.script['executor'] = () => write('src/fee.ts', 'export const fee = () => 3;\n');
    engine.script['scanner'] = async (task) =>
      void (await new SpecStore(join(task.cwd, '.alethic'), () => CLOCK).upsertRule({
        domain: 'payments',
        sub: 'fees',
        title: 'A service fee is added after the discount',
        body: 'The fee lands after the discount, before tax.',
      }));

    expect(flow.executePhase(PLAN_ID, 0, MODEL)).toEqual({ started: true });
    await settle(() => engine.runs.length === 2 && idle());

    // the executor ran first, then the code-map scanner pass it triggered (decision 55)
    expect(engine.runs.map((r) => r.role)).toEqual(['executor', 'scanner']);
    expect(engine.runs[0]!.prompt).toContain('Add the fee module');
    expect(engine.runs[1]!.prompt).toContain('src/fee.ts');

    const phases = parsePlanPhases(planBody());
    expect(phases[0]!.done).toBe(true);
    expect(phases[1]!.done).toBe(false); // the next phase is untouched
    // the phase records its own outcome in the plan document — one line, rewritten in place
    expect(phases[0]!.note).toContain('done 2026-07-30');
    expect(phases[0]!.note).toContain('1 file: src/fee.ts');
    expect(phases[0]!.note).toContain('1 rule mapped into payments/fees');
    expect(planBody().match(/^>\s*✓/gm)).toHaveLength(1);

    expect(nodes().some((n) => n.meta?.kind === 'rule')).toBe(true);
    expect(progress.map((p) => p.phase)).toEqual(['executing', 'mapping', 'done']);
  });

  it('two phases queue: one runs at a time, both land in order', async () => {
    engine.held.add('executor');
    engine.script['executor'] = () => {};
    engine.script['scanner'] = () => {};

    flow.executePhase(PLAN_ID, 0, MODEL);
    flow.executePhase(PLAN_ID, 1, MODEL);
    await settle(() => agent.activeTask().taskId !== null);

    // the second phase waits for the first (one agent slot, decision 25)
    expect(flow.phaseStatus(PLAN_ID)).toEqual({ running: [0], queued: [1] });

    engine.releaseAll();
    await settle(() => parsePlanPhases(planBody()).every((p) => p.done) && idle());

    expect(engine.runs.map((r) => r.role)).toEqual(['executor', 'executor', 'scanner', 'scanner']);
    expect(parsePlanPhases(planBody()).map((p) => p.done)).toEqual([true, true]);
    expect(flow.phaseStatus(PLAN_ID)).toEqual({ running: [], queued: [] });
  });

  it('Stop cancels the run: nothing is ticked and no code-map pass follows', async () => {
    engine.held.add('executor');
    engine.script['executor'] = () => write('src/fee.ts', 'half-written\n');

    flow.executePhase(PLAN_ID, 0, MODEL);
    await settle(() => agent.activeTask().taskId !== null);
    agent.cancel(agent.activeTask().taskId!); // the Stop button
    await settle(() => progress.some((p) => p.phase === 'blocked'));

    expect(engine.runs.map((r) => r.role)).toEqual(['executor']); // no scanner pass
    const phases = parsePlanPhases(planBody());
    expect(phases[0]!.done).toBe(false);
    expect(phases[0]!.note).toBeUndefined();
    expect(progress.at(-1)).toMatchObject({ phase: 'blocked', phaseIndex: 0 });
    expect(flow.phaseStatus(PLAN_ID)).toEqual({ running: [], queued: [] });
  });

  it('a chat request grows the same plan document instead of starting a second one', async () => {
    engine.script['planner'] = (task) => {
      const body = `${PLAN_BODY}\n\n## Phase 3 — Refunds\n- [ ] Refund the fee\n`;
      new SpecStore(join(task.cwd, '.alethic'), () => CLOCK).upsertPlan({
        id: PLAN_ID,
        slug: 'roadmap',
        title: 'Ship the fee',
        goal: 'Add a service fee',
        body,
      });
    };

    flow.createPlan('also refund the fee when an order is cancelled', MODEL);
    await settle(idle);

    expect(engine.runs[0]!.role).toBe('planner');
    expect(engine.runs[0]!.prompt).toContain(`id "${PLAN_ID}"`); // the plan that exists
    expect(nodes().filter((n) => n.meta?.kind === 'plan')).toHaveLength(1);
    expect(parsePlanPhases(planBody()).map((p) => p.title)).toEqual([
      'Phase 1 — Skeleton',
      'Phase 2 — Wire it up',
      'Phase 3 — Refunds',
    ]);
  });
});
