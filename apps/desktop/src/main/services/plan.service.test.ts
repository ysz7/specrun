import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchorFor, loadAlethicDir, parsePlanPhases, serialize } from '@alethic/format';
import { SpecStore } from '@alethic/agent';
import type { PlanProgress } from '@alethic/ipc';
import { PlanService } from './plan.service';
import { GitService } from './git.service';

const GOLDEN = join(process.cwd(), 'fixtures/golden/acme-commerce-src');
const CLOCK = '2020-01-01T00:00:00Z';
const DISCOUNTS = 'src/payments/discounts.ts';

describe('PlanService', () => {
  let tmp: string;
  let alethicDir: string;
  let plan: PlanService;
  let progress: PlanProgress[];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-plan-'));
    cpSync(GOLDEN, tmp, { recursive: true });
    alethicDir = join(tmp, '.alethic');
    mkdirSync(join(alethicDir, 'domains', 'payments'), { recursive: true });
    writeFileSync(
      join(alethicDir, 'config.yaml'),
      'format: 1\nlanguage: en\nstack: []\nscan:\n  include: ["**"]\n  exclude: []\nlimits:\n  max_rules_per_sub: 40\n',
    );
    writeFileSync(
      join(alethicDir, 'alethic.md'),
      `---\nid: a-000001\nkind: root\ntitle: golden\ncreated: ${CLOCK}\nupdated: ${CLOCK}\nupdated_by: scanner\n---\n\nGolden.\n`,
    );
    writeFileSync(
      join(alethicDir, 'domains', 'payments', '_domain.md'),
      serialize({
        meta: {
          id: 'd-000001',
          kind: 'domain',
          title: 'Payments',
          scope: ['src/payments/**'],
          created: CLOCK,
          updated: CLOCK,
          updated_by: 'scanner',
        },
        body: 'The payments domain.',
      }),
    );

    // An existing rule anchored to the real applyDiscounts symbol (status ok).
    const source = readFileSync(join(tmp, DISCOUNTS), 'utf8');
    const anchor = await anchorFor(DISCOUNTS, source, 'applyDiscounts');
    const store = new SpecStore(alethicDir, () => CLOCK);
    await store.upsertRule(
      {
        id: 'r-000001',
        domain: 'payments',
        sub: 'pricing',
        title: 'Discount before tax',
        body: 'A discount applies to the subtotal before tax.',
        anchors: [anchor!],
      },
      'scanner',
    );
    // The project's single living plan document (decision 55).
    store.upsertPlan({
      id: 'p-000001',
      slug: 'add-fee',
      title: 'Add a service fee',
      goal: 'Add a fee',
      domains: ['d-000001'],
    });

    plan = new PlanService(new GitService(), () => CLOCK);
    plan.setProject(tmp);
    progress = [];
    plan.onProgress((p) => progress.push(p));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const nodes = (): ReturnType<typeof loadAlethicDir>['nodes'] => loadAlethicDir(alethicDir).nodes;
  const planBody = (): string => nodes().find((n) => n.meta?.id === 'p-000001')!.body;

  // ── dev-planning v2: phases + the code map they feed (decision 55) ──
  describe('phase execution', () => {
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

    beforeEach(() => {
      new SpecStore(alethicDir, () => CLOCK).upsertPlan({
        id: 'p-000001',
        slug: 'add-fee',
        title: 'Add a service fee',
        goal: 'Add a fee',
        body: PLAN_BODY,
      });
    });

    const prep = (i: number) => plan.preparePhase('p-000001', i, 'claude-opus-5');

    it('a follow-up request grows the existing plan document, not a second one', () => {
      const { prompt } = plan.buildPlanTask('also add a refund flow');
      expect(prompt).toContain('id "p-000001"'); // the plan that exists, not a fresh "roadmap"
      expect(prompt).toContain('Phase 1 — Skeleton (0/2 done)');
      expect(prompt).toContain('Phase 2 — Wire it up (0/1 done)');
      expect(prompt).toContain('extending the document, not rewriting it');
      // the outcome lines the system wrote under finished phases must survive the rewrite
      expect(prompt).toContain('"> ✓" outcome line verbatim');
      expect(prompt).toContain('Never write a "> ✓" line yourself');
    });

    it('builds an executor run for one phase, listing only its open items', () => {
      const task = prep(0);
      expect(task?.phaseTitle).toBe('Phase 1 — Skeleton');
      expect(task?.prompt).toContain('Add the fee module');
      expect(task?.prompt).not.toContain('Call it from checkout'); // phase 2 stays out of scope
      expect(task?.model).toBe('claude-opus-5');
      expect(prep(9)).toBeNull();
    });

    it('a finished phase ticks its checkboxes and asks for a code-map pass', () => {
      const requests: { prompt: string; model: string; phaseIndex?: number }[] = [];
      plan.onCodeMap((r) => requests.push(r));

      plan.trackPhase('task-1', prep(0)!);
      plan.handleAgentEvent({ taskId: 'task-1', type: 'done', ok: true });

      const body = nodes().find((n) => n.meta?.id === 'p-000001')!.body;
      expect(body).toContain('- [x] Add the fee module');
      expect(body).toContain('- [ ] Call it from checkout'); // phase 2 untouched

      expect(progress.map((p) => p.phase)).toContain('mapping');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.phaseIndex).toBe(0);
      expect(requests[0]!.prompt).toContain('alethic_upsert_rule');
      // one node per FEATURE, written into the map that already exists (decision 56)
      expect(requests[0]!.prompt).toContain('alethic_read_map');
      expect(requests[0]!.prompt).toContain('FEATURE');
      expect(requests[0]!.model).toBe('claude-opus-5');

      // …and when the map pass lands, the phase row clears.
      plan.trackCodeMap('task-2', { role: 'scanner', ...requests[0]!, planId: 'p-000001' });
      plan.handleAgentEvent({ taskId: 'task-2', type: 'done', ok: true });
      expect(progress.at(-1)).toMatchObject({ phase: 'done', message: 'Code map updated.' });
    });

    it('records what the phase produced in the plan document, not in a new node file', async () => {
      plan.onCodeMap(() => {});
      const before = nodes().length;

      plan.trackPhase('task-1', prep(0)!);
      plan.handleAgentEvent({ taskId: 'task-1', type: 'done', ok: true });
      expect(parsePlanPhases(planBody())[0]!.note).toMatch(/^done \d{4}-\d{2}-\d{2}/);

      // The code-map pass then adds a rule; the same note is rewritten, never duplicated.
      const rulesBefore = nodes()
        .filter((n) => n.meta?.kind === 'rule')
        .map((n) => n.meta!.id);
      await new SpecStore(alethicDir, () => CLOCK).upsertRule({
        domain: 'payments',
        sub: 'fees',
        title: 'A service fee is added after discount',
        body: 'The fee lands after the discount.',
      });
      plan.trackCodeMap('task-2', {
        role: 'scanner',
        prompt: '',
        model: 'claude-opus-5',
        planId: 'p-000001',
        phaseIndex: 0,
        phaseTitle: 'Phase 1 — Skeleton',
        rulesBefore,
      });
      plan.handleAgentEvent({ taskId: 'task-2', type: 'done', ok: true });

      const note = parsePlanPhases(planBody())[0]!.note!;
      expect(note).toContain('1 rule mapped into payments/fees');
      expect(planBody().match(/^>\s*✓/gm)).toHaveLength(1); // one line, rewritten in place
      // and no new plan node was created for the finished phase
      expect(nodes().filter((n) => n.meta?.kind === 'plan')).toHaveLength(1);
      expect(nodes().length).toBeGreaterThan(before); // only the rule + its containers
      expect(nodes().some((n) => n.meta?.kind === 'plan-step')).toBe(false);
    });

    it('a failed phase is reported blocked — no checkboxes, no code-map pass', () => {
      const requests: unknown[] = [];
      plan.onCodeMap((r) => requests.push(r));

      plan.trackPhase('task-1', prep(0)!);
      plan.handleAgentEvent({ taskId: 'task-1', type: 'error', message: 'nope' });

      expect(nodes().find((n) => n.meta?.id === 'p-000001')!.body).toContain(
        '- [ ] Add the fee module',
      );
      expect(requests).toHaveLength(0);
      expect(progress.at(-1)?.phase).toBe('blocked');
    });

    it('a code-map run can be asked for on its own (no phase attached)', () => {
      const requests: { prompt: string; phaseIndex?: number }[] = [];
      plan.onCodeMap((r) => requests.push(r));
      expect(plan.requestCodeMap('claude-opus-5')).toEqual({ started: true });
      expect(requests[0]!.phaseIndex).toBeUndefined();
      expect(requests[0]!.prompt).toContain('code map up to date');
    });

    // Phase 6 task 3: the code map that grows after a phase runs through the same scanner as a
    // scan, so it must produce the same unit. It also lands inside a branch that already has
    // siblings — the one place a container quietly grows an eighth child (decision 56's measure).
    it('the post-phase code map asks for features, in the shape a feature has', () => {
      const requests: { prompt: string; role: string }[] = [];
      plan.onCodeMap((r) => requests.push(r));
      plan.trackPhase('task-1', prep(0)!);
      plan.handleAgentEvent({ taskId: 'task-1', type: 'done', ok: true });

      const { prompt, role } = requests[0]!;
      expect(role).toBe('scanner'); // the same role, so the same feature few-shot applies
      expect(prompt).toContain('one node per');
      expect(prompt).toContain('FEATURE');
      for (const section of ['## How it works', '## Where it is used', '## Invariants'])
        expect(prompt).toContain(section);
      expect(prompt).toContain('updated by its id, never duplicated beside itself');
      expect(prompt).toContain('more than 7 children');
      expect(prompt).toContain('alethic_upsert_container');
      expect(prompt).toContain('alethic_read_map');
      // …and never the old unit
      expect(prompt).not.toContain('assertion');
      expect(prompt).not.toContain('one node per sentence.');
    });
  });

  it('greenfield ensureRoot seeds a project skeleton (decision 29)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'alethic-green-'));
    const p = new PlanService(new GitService(), () => CLOCK);
    p.setProject(empty);
    const task = p.buildGreenfieldTask('a todo app');
    expect(task.role).toBe('planner');
    expect(task.prompt).toContain('alethic_set_thesis');
    expect(existsSync(join(empty, '.alethic', 'alethic.md'))).toBe(true);
    // A branch is only claimed once its tree holds something (decision 55).
    p.ensureSections();
    expect(existsSync(join(empty, '.alethic', 'domains', '_section.md'))).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });

  it('an existing map grows its Plan/Code branches on open (decision 55 migration)', () => {
    plan.ensureSections();
    expect(existsSync(join(alethicDir, 'plans', '_section.md'))).toBe(true);
    expect(existsSync(join(alethicDir, 'domains', '_section.md'))).toBe(true);
  });
});
