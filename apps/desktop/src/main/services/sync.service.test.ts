import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchorFor, parse } from '@alethic/format';
import { SpecStore, type AgentEngine, type AgentEvent, type AgentTask } from '@alethic/agent';
import { SyncService } from './sync.service';
import { GitService } from './git.service';

const GOLDEN = join(process.cwd(), 'fixtures/golden/acme-commerce-src');
const CLOCK = '2020-01-01T00:00:00Z'; // a fixed past clock so mtime always reads as "after"
const DISCOUNTS = 'src/payments/discounts.ts';

/** A fake engine that records the sync tasks it was asked to run (it renders no verdict). */
class FakeEngine implements AgentEngine {
  tasks: AgentTask[] = [];
  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    yield { type: 'done', ok: true };
  }
}

const RULE_PATH = 'domains/payments/pricing/discount-before-tax.md';

describe('SyncService', () => {
  let tmp: string;
  let engine: FakeEngine;
  let sync: SyncService;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-sync-'));
    cpSync(GOLDEN, tmp, { recursive: true });
    const alethicDir = join(tmp, '.alethic');
    mkdirSync(alethicDir, { recursive: true });
    writeFileSync(
      join(alethicDir, 'config.yaml'),
      'format: 1\nlanguage: en\nstack: []\nscan:\n  include: ["**"]\n  exclude: []\nlimits:\n  max_rules_per_sub: 40\n',
    );
    writeFileSync(
      join(alethicDir, 'alethic.md'),
      `---\nid: a-000001\nkind: root\ntitle: golden\ncreated: ${CLOCK}\nupdated: ${CLOCK}\nupdated_by: scanner\n---\n\nGolden.\n`,
    );

    // Anchor a rule to the real applyDiscounts symbol in the copied source.
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
        status: 'ok',
        anchors: [anchor!],
      },
      'scanner',
    );

    engine = new FakeEngine();
    sync = new SyncService(engine, new GitService(), () => CLOCK);
    sync.setProject(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const ruleStatus = (): string =>
    (parse(readFileSync(join(tmp, '.alethic', RULE_PATH), 'utf8')).meta as { status: string })
      .status;

  it('a first sync over unchanged code finds no drift', async () => {
    const result = await sync.sync('claude-sonnet-5');
    expect(result.ran).toBe(true);
    expect(result.method).toBe('mtime'); // tmp is not a git repo
    expect(result.staleCount).toBe(0);
    expect(ruleStatus()).toBe('ok');
    expect(engine.tasks).toHaveLength(0); // nothing to judge
  });

  it('marks a rule stale and auto-judges it when its anchored code changes (decision 18)', async () => {
    await sync.sync('claude-sonnet-5'); // establish the baseline

    // change the behaviour of applyDiscounts
    const edited = readFileSync(join(tmp, DISCOUNTS), 'utf8').replace(
      'order.subtotal * (1 - pct)',
      'order.subtotal * (1 - pct) * 0.9',
    );
    writeFileSync(join(tmp, DISCOUNTS), edited);

    const result = await sync.sync('claude-sonnet-5');
    expect(result.staleCount).toBe(1);
    expect(ruleStatus()).toBe('stale'); // the fake engine renders no verdict, so it stays stale
    // the Sync agent was invoked to judge the stale rule
    expect(engine.tasks).toHaveLength(1);
    expect(engine.tasks[0]?.role).toBe('sync');
    expect(engine.tasks[0]?.prompt).toContain('r-000001');
  });

  // Decision 56 took a blunter drift signal as the price of the feature unit and named the
  // compensation. Phase 6 pays it: the judge is told which symbol moved, which part of the body
  // describes it, and how much of the feature the deterministic check found untouched — so its
  // verdict is about that place, not about re-reading the whole node.
  it('tells the judge which part of the feature moved, and what did not', async () => {
    // Re-write the rule as a real feature: two anchors in two files, sections that name them.
    const source = readFileSync(join(tmp, DISCOUNTS), 'utf8');
    const refundsFile = 'src/payments/refunds.ts';
    const refunds = readFileSync(join(tmp, refundsFile), 'utf8');
    const store = new SpecStore(join(tmp, '.alethic'), () => CLOCK);
    await store.upsertRule({
      id: 'r-000001',
      domain: 'payments',
      sub: 'pricing',
      title: 'Discount before tax',
      body: [
        'Pricing turns an order into the amount a customer owes.',
        '',
        '## How it works',
        'applyDiscounts subtracts the promo share from the subtotal.',
        '',
        '## Invariants',
        '- processRefund never returns more than was captured',
      ].join('\n'),
      status: 'ok',
      anchors: [
        (await anchorFor(DISCOUNTS, source, 'applyDiscounts'))!,
        (await anchorFor(refundsFile, refunds, 'processRefund'))!,
      ],
    });

    await sync.sync('claude-sonnet-5'); // baseline
    writeFileSync(
      join(tmp, DISCOUNTS),
      source.replace('order.subtotal * (1 - pct)', 'order.subtotal * (1 - pct) * 0.9'),
    );
    engine.tasks.length = 0;
    const result = await sync.sync('claude-sonnet-5');

    // …and the same sentence reaches the user, before the judge has said anything (decision 15's
    // passive banner): "3 newly stale" alone says nothing about where to look.
    expect(result.staleAt).toEqual([
      'Discount before tax — changed: applyDiscounts (## How it works) · 1 other anchor unchanged',
    ]);

    const prompt = engine.tasks[0]!.prompt;
    expect(prompt).toContain('WHAT MOVED (the deterministic check, not a guess)');
    expect(prompt).toContain('applyDiscounts (## How it works)');
    expect(prompt).toContain('1 other anchor unchanged'); // processRefund was never in the diff
    expect(prompt).toContain('- applyDiscounts — stale, described in ## How it works');
    expect(prompt).toContain('name the place inside the feature');
    // the untouched half of the feature is not what this run is about
    expect(prompt).not.toContain('- processRefund — ');
  });

  it('records last_sync_commit/time in state.json', async () => {
    await sync.sync('claude-sonnet-5');
    const state = JSON.parse(readFileSync(join(tmp, '.alethic', 'state.json'), 'utf8'));
    expect(state.last_sync_time).toBe(CLOCK);
  });

  it('builds an update-from-code task for an agent rule and a propose-only task for a locked one', () => {
    const agentTask = sync.buildUpdateFromCodeTask('r-000001');
    expect(agentTask?.role).toBe('scanner');
    expect(agentTask?.prompt).toContain('alethic_upsert_rule');

    // lock the rule on disk, then rebuild the task → must switch to propose_edit
    const abs = join(tmp, '.alethic', RULE_PATH);
    writeFileSync(
      abs,
      readFileSync(abs, 'utf8').replace('provenance: "agent"', 'provenance: "human"'),
    );
    const humanTask = sync.buildUpdateFromCodeTask('r-000001');
    expect(humanTask?.prompt).toContain('alethic_propose_edit');
    expect(humanTask?.prompt).not.toContain('alethic_upsert_rule');
  });

  it('plans the regression fix as a phase of the single plan document (decisions 28/55)', () => {
    const task = sync.buildRegressionTask('r-000001');
    expect(task?.role).toBe('planner');
    expect(task?.prompt).toContain('alethic_upsert_plan');
    expect(task?.prompt).toContain('## Phase N — Fix:');
    expect(task?.prompt).toContain('extending the document, not rewriting it');
    // the per-step pipeline is gone (decision 55 replaces 25/27/42)
    expect(task?.prompt).not.toContain('alethic_upsert_plan_step');
  });
});
