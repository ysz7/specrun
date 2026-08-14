import type * as NodeFs from 'node:fs';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A switchable `rmSync` failure, for the one test that needs a delete to fail like it does on
// Windows under a watcher. Everything else in node:fs passes straight through. (A namespace spy
// is not possible: ESM exports are non-configurable.)
const rmFails = vi.hoisted(() => ({ enabled: false, calls: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    default: actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (!rmFails.enabled) return actual.rmSync(...args);
      rmFails.calls += 1;
      throw Object.assign(new Error('ENOTEMPTY, Directory not empty'), { code: 'ENOTEMPTY' });
    },
  };
});
import { SpecStore, type AgentEngine, type AgentEvent, type AgentTask } from '@alethic/agent';
import { serialize } from '@alethic/format';
import type { DomainProposal, ScanProgress } from '@alethic/ipc';
import { ScanService } from './scan.service';

const GOLDEN = join(process.cwd(), 'fixtures/golden/acme-commerce-src');
const ACME = join(process.cwd(), 'fixtures/acme-commerce');

/** A fake engine that records tasks; optionally slow, so concurrency is observable. */
class FakeEngine implements AgentEngine {
  tasks: AgentTask[] = [];
  inFlight = 0;
  maxInFlight = 0;
  reply = '';
  delayMs = 0;
  toolEvents: AgentEvent[] = [];
  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    this.tasks.push(task);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      for (const event of this.toolEvents) yield event;
      if (this.reply) yield { type: 'text', text: this.reply };
      yield { type: 'done', ok: true };
    } finally {
      this.inFlight -= 1;
    }
  }
}

const domains: DomainProposal[] = [
  { slug: 'payments', title: 'Payments', scope: ['src/payments/**'] },
  { slug: 'auth', title: 'Auth', scope: ['src/auth/**'] },
  { slug: 'orders', title: 'Orders', scope: ['src/orders/**'] },
];

describe('ScanService', () => {
  let tmp: string;
  let engine: FakeEngine;
  let scan: ScanService;
  let progress: ScanProgress[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-scan-'));
    cpSync(GOLDEN, tmp, { recursive: true });
    engine = new FakeEngine();
    scan = new ScanService(engine, () => '2026-07-16T00:00:00Z');
    progress = [];
    scan.onProgress((p) => progress.push(p));
    scan.setProject(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('previews cost from the repo-map without spending tokens', async () => {
    const preview = await scan.preview();
    expect(engine.tasks).toHaveLength(0); // repo-map is free
    expect(preview.files).toBeGreaterThan(0);
    expect(preview.domains.map((d) => d.slug)).toEqual(
      expect.arrayContaining(['payments', 'auth', 'orders']),
    );
    expect(preview.estimatedCalls).toBe(1 + preview.domains.length);
    expect(preview.large).toBe(false);
    expect(preview.threshold).toBe(800);
  });

  it('seeds every domain card before scanning (coverage is never traded)', async () => {
    engine.delayMs = 1;
    await scan.start('claude-sonnet-5', domains);
    for (const d of domains) {
      const card = join(tmp, '.alethic', 'domains', d.slug, '_domain.md');
      expect(existsSync(card)).toBe(true);
      expect(readFileSync(card, 'utf8')).toContain(`title: "${d.title}"`);
    }
    expect(existsSync(join(tmp, '.alethic', 'alethic.md'))).toBe(true);
  });

  it('scans domains in parallel, capped at 3', async () => {
    engine.delayMs = 15;
    await scan.start('claude-sonnet-5', domains);
    expect(engine.tasks).toHaveLength(3);
    expect(engine.maxInFlight).toBeGreaterThan(1);
    expect(engine.maxInFlight).toBeLessThanOrEqual(3);
    expect(progress.at(-1)).toMatchObject({ phase: 'done', completed: 3, total: 3 });
  });

  // A running scan and a dead one look identical from outside: `completed` only moves when a whole
  // domain finishes, and three run at once, so a ten-domain repository sits at "0 / 10" through
  // minutes of real model work (PLAN.md known issues). This is the pulse from inside a domain.
  it('pulses progress with the file being read and a running feature count', async () => {
    engine.toolEvents = [
      { type: 'tool', name: 'Read', input: { file_path: join(tmp, 'src/payments/discounts.ts') } },
      { type: 'tool', name: 'mcp__alethic__alethic_upsert_rule', input: {} },
      { type: 'tool', name: 'mcp__alethic__alethic_upsert_rule', input: {} },
    ];
    await scan.start('claude-sonnet-5', [domains[0]!]);
    const messages = progress.map((p) => p.message).filter((m): m is string => !!m);
    expect(messages).toEqual(
      expect.arrayContaining([
        'reading src/payments/discounts.ts',
        '1 feature written',
        '2 features written',
      ]),
    );
  });

  // `ScanService` used to be constructed with the engine directly, bypassing `AgentService` — the
  // only writer of the JSONL run logs — so a scan that hung left nothing to diagnose it with
  // (PLAN.md known issues). Given a logs directory, it now writes one log per agent run, in the
  // same shape `AgentService` does, so `agent.listLogs()` picks it up without changes.
  it('writes a JSONL run log per domain when given a logs directory', async () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'alethic-scan-logs-'));
    try {
      const logged = new ScanService(engine, () => '2026-07-16T00:00:00Z', logsDir);
      logged.setProject(tmp);
      await logged.start('claude-sonnet-5', [domains[0]!]);

      const files = readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'));
      expect(files).toHaveLength(1);
      const lines = readFileSync(join(logsDir, files[0]!), 'utf8').trim().split('\n');
      const first = JSON.parse(lines[0]!) as { kind: string; role: string; model: string };
      expect(first).toMatchObject({ kind: 'start', role: 'scanner', model: 'claude-sonnet-5' });
      expect(lines.some((l) => (JSON.parse(l) as { kind: string }).kind === 'event')).toBe(true);
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('sends shallow depth for domains not chosen for a deep scan (decision 39)', async () => {
    await scan.start('claude-sonnet-5', domains, ['payments']);
    const byDomain = Object.fromEntries(
      engine.tasks.map((t) => [/"(\w+)"/.exec(t.prompt)?.[1], t.depth]),
    );
    expect(byDomain['payments']).toBe('full');
    expect(byDomain['auth']).toBe('shallow');
  });

  it('cancel keeps scanned domains and leaves the rest marked not-scanned (decision 36)', async () => {
    engine.delayMs = 30;
    const run = scan.start('claude-sonnet-5', domains);
    setTimeout(() => scan.cancel(), 5);
    await run;
    expect(progress.at(-1)?.phase).toBe('cancelled');
    const cards = domains.map((d) =>
      readFileSync(join(tmp, '.alethic', 'domains', d.slug, '_domain.md'), 'utf8'),
    );
    // every domain still has a card; at least one still carries the not-scanned marker
    expect(cards).toHaveLength(3);
    expect(cards.some((c) => c.includes('Not scanned yet'))).toBe(true);
  });

  it('decompose parses the model JSON and falls back to repo-map candidates', async () => {
    engine.reply =
      'Here you go:\n[{"slug":"billing","title":"Billing","scope":["src/payments/**"]}]';
    expect(await scan.decompose('claude-sonnet-5')).toEqual([
      { slug: 'billing', title: 'Billing', scope: ['src/payments/**'] },
    ]);

    engine.reply = 'no json here';
    const fallback = await scan.decompose('claude-sonnet-5');
    expect(fallback.map((d) => d.slug)).toEqual(
      expect.arrayContaining(['payments', 'auth', 'orders']),
    );
  });

  // A live run produced domain cards literally titled "Node schema &amp; identity" — the model
  // escaped the "&" in its JSON reply and it landed on the card verbatim (PLAN.md known issues).
  it('decompose decodes HTML entities the model escaped into a domain title/description', async () => {
    engine.reply =
      '[{"slug":"node-schema","title":"Node schema &amp; identity","description":"IDs &amp; hashes.","scope":["src/**"]}]';
    expect(await scan.decompose('claude-sonnet-5')).toEqual([
      {
        slug: 'node-schema',
        title: 'Node schema & identity',
        description: 'IDs & hashes.',
        scope: ['src/**'],
      },
    ]);
  });

  it('backs up .alethic before destructive operations (decision 43)', async () => {
    await scan.start('claude-sonnet-5', domains);
    const dest = scan.backup();
    expect(dest).toBeTruthy();
    expect(existsSync(join(dest!, 'alethic.md'))).toBe(true);
    expect(readdirSync(join(tmp, '.alethic', '.backup'))).toHaveLength(1);
  });

  // Phase 2.1, found live: Deepen died in `backup()` with ENOTEMPTY (the watcher held handles in
  // `.alethic/.backup/`), the rejection was swallowed by the renderer, and the button read as dead.
  describe('narrow passes (deepen / rescan) report instead of vanishing', () => {
    // Phase 4 / decision 56: Deepen enriches the node the user clicked. The prompt therefore
    // carries that node's own body, anchors and neighbours — without them the agent writes a fresh
    // description over what is already on the map — and the pass never grows the node count.
    it('deepen aims at one feature: its body and place in the spec go into the prompt', async () => {
      const acmeTmp = mkdtempSync(join(tmpdir(), 'alethic-deepen-one-'));
      cpSync(ACME, acmeTmp, { recursive: true });
      const deepener = new ScanService(engine, () => '2026-07-16T00:00:00Z');
      deepener.setProject(acmeTmp);
      const before = readdirSync(join(acmeTmp, '.alethic', 'domains', 'payments', 'discounts'));

      try {
        expect(await deepener.deepen('r-000001', 'claude-sonnet-5')).toEqual({ started: true });
        const prompt = engine.tasks.at(-1)!.prompt;
        expect(prompt).toContain('Deepen ONE node — the feature "Discounting an order"');
        expect(prompt).toContain('before tax'); // the body it must extend, not replace
        expect(prompt).toContain('src/payments.ts · applyDiscounts');
        expect(prompt).toContain('Parent: Discounts');
        expect(prompt).toContain('Promo codes'); // its sibling, which it must leave alone
        expect(prompt).toContain(
          'alethic_upsert_rule(id: "r-000001", path: ["payments","discounts"]',
        );
        // …and, if it ever overflows, its children go one level deeper — under its own slug
        expect(prompt).toContain('["payments","discounts","discounting-an-order"]');

        // the pass writes no neighbours: the same files are there afterwards
        expect(readdirSync(join(acmeTmp, '.alethic', 'domains', 'payments', 'discounts'))).toEqual(
          before,
        );
        // …and the node is marked as read closely, so the card can say so (decision 39's depth)
        const written = readFileSync(
          join(acmeTmp, '.alethic', 'domains', 'payments', 'discounts', 'discounting-an-order.md'),
          'utf8',
        );
        expect(written).toContain('depth: "full"');
      } finally {
        rmSync(acmeTmp, { recursive: true, force: true });
      }
    });

    it('deepen on a container asks for the features it is missing, not for a body it has none of', async () => {
      const acmeTmp = mkdtempSync(join(tmpdir(), 'alethic-deepen-sub-'));
      cpSync(ACME, acmeTmp, { recursive: true });
      const deepener = new ScanService(engine, () => '2026-07-16T00:00:00Z');
      deepener.setProject(acmeTmp);
      try {
        expect(await deepener.deepen('s-000001', 'claude-sonnet-5')).toEqual({ started: true });
        const prompt = engine.tasks.at(-1)!.prompt;
        expect(prompt).toContain('Deepen the branch "Discounts"');
        expect(prompt).toContain('FEATURES');
        // a container carries no depth mark of its own from this pass
        expect(
          readFileSync(
            join(acmeTmp, '.alethic', 'domains', 'payments', 'discounts', '_sub.md'),
            'utf8',
          ),
        ).not.toContain('depth:');
      } finally {
        rmSync(acmeTmp, { recursive: true, force: true });
      }
    });

    it('deepen runs the scanner and reports scanning → done', async () => {
      // A map with real rules to deepen: the golden fixture's rules come from the agent, which the
      // fake engine never writes.
      const acmeTmp = mkdtempSync(join(tmpdir(), 'alethic-deepen-'));
      cpSync(ACME, acmeTmp, { recursive: true });
      const seen: ScanProgress[] = [];
      const deepener = new ScanService(engine, () => '2026-07-16T00:00:00Z');
      deepener.onProgress((p) => seen.push(p));
      deepener.setProject(acmeTmp);
      const nodeId = deepener.calibrationRules()[0]!.id;

      try {
        expect(await deepener.deepen(nodeId, 'claude-sonnet-5')).toEqual({ started: true });
        expect(engine.tasks.map((t) => t.role)).toEqual(['scanner']);
        expect(seen.map((p) => p.phase)).toEqual(['scanning', 'scanning', 'done']);
        expect(seen[1]!.domain).toBeTruthy(); // the branch being deepened is named
      } finally {
        rmSync(acmeTmp, { recursive: true, force: true });
      }
    });

    it('refuses a second pass while one is running, and says so', async () => {
      engine.delayMs = 30; // hold the first pass open
      const acmeTmp = mkdtempSync(join(tmpdir(), 'alethic-busy-'));
      cpSync(ACME, acmeTmp, { recursive: true });
      const seen: ScanProgress[] = [];
      const busy = new ScanService(engine, () => '2026-07-16T00:00:00Z');
      busy.onProgress((p) => seen.push(p));
      busy.setProject(acmeTmp);
      const nodeId = busy.calibrationRules()[0]!.id;

      try {
        const first = busy.deepen(nodeId, 'claude-sonnet-5');
        await Promise.resolve(); // the first pass is in flight
        expect(busy.active().running).toBe(true);
        expect(await busy.deepen(nodeId, 'claude-sonnet-5')).toEqual({ started: false });
        expect(seen.at(-1)).toMatchObject({ phase: 'error' });
        expect(seen.at(-1)!.message).toMatch(/already running/);

        expect(await first).toEqual({ started: true });
        expect(engine.tasks).toHaveLength(1); // the second click never reached the model
        expect(busy.active()).toEqual({ running: false });
      } finally {
        engine.delayMs = 0;
        rmSync(acmeTmp, { recursive: true, force: true });
      }
    });

    // Found while wiring Deepen: `cancelled` was only reset by start(), so after a cancelled scan
    // every later narrow pass broke out of the stream on its first event — Deepen did nothing and
    // still reported success.
    it('a cancelled scan does not poison the next deepen', async () => {
      engine.delayMs = 30;
      const run = scan.start('claude-sonnet-5', domains);
      setTimeout(() => scan.cancel(), 5);
      await run;
      engine.delayMs = 0;

      const acmeTmp = mkdtempSync(join(tmpdir(), 'alethic-after-cancel-'));
      cpSync(ACME, acmeTmp, { recursive: true });
      try {
        scan.setProject(acmeTmp);
        expect(await scan.deepen('r-000001', 'claude-sonnet-5')).toEqual({ started: true });
        expect(
          readFileSync(
            join(
              acmeTmp,
              '.alethic',
              'domains',
              'payments',
              'discounts',
              'discounting-an-order.md',
            ),
            'utf8',
          ),
        ).toContain('depth: "full"'); // the pass really ran
      } finally {
        scan.setProject(tmp);
        rmSync(acmeTmp, { recursive: true, force: true });
      }
    });

    it('a failing pass surfaces as error progress, not a rejected call', async () => {
      progress.length = 0;
      await expect(scan.deepen('r-nosuch', 'claude-sonnet-5')).resolves.toEqual({ started: false });
      expect(progress.at(-1)).toMatchObject({ phase: 'error' });
      expect(progress.at(-1)!.message).toMatch(/no longer in the map/);

      scan.setProject(null); // no project open — used to reject out of alethicDir()
      await expect(scan.rescanDomain('payments', 'claude-sonnet-5')).resolves.toEqual({
        started: false,
      });
      expect(progress.at(-1)).toMatchObject({ phase: 'error', message: 'No project is open.' });
    });

    /** Six old whole-map snapshots, as `backup()` itself would have left them. */
    const seedSnapshots = (backups: string): void => {
      for (const stamp of [
        '2000-01-01',
        '2000-01-02',
        '2000-01-03',
        '2000-01-04',
        '2000-01-05',
        '2000-01-06',
      ]) {
        mkdirSync(join(backups, stamp), { recursive: true });
        writeFileSync(join(backups, stamp, 'alethic.md'), '---\nkind: root\n---\n', 'utf8');
      }
    };

    it('a snapshot that cannot be deleted does not fail the backup (pruning is housekeeping)', () => {
      // The real failure: chokidar watched `.alethic/.backup/`, so deleting the oldest snapshot hit
      // ENOTEMPTY. Simulated at the syscall, because a handle held by Node alone does not block a
      // delete on Windows — only a watcher's does.
      const backups = join(tmp, '.alethic', '.backup');
      seedSnapshots(backups);

      rmFails.enabled = true;
      rmFails.calls = 0;
      try {
        expect(scan.backup()).toBeTruthy(); // the snapshot is taken; the stale dir just stays
        expect(rmFails.calls).toBeGreaterThan(0); // …and pruning really was attempted
      } finally {
        rmFails.enabled = false;
      }
    });

    // Found by the first live migration (python-app, Phase 6): `.backup/` is shared with
    // `alethic_retire_rule`, which drops one retired node per timestamped folder. Counting those
    // towards the five meant a pass that retired four nodes evicted the whole-map snapshot taken
    // moments earlier to make that very pass reversible.
    it('retired single nodes never evict the whole-map snapshots (decision 43)', () => {
      const backups = join(tmp, '.alethic', '.backup');
      seedSnapshots(backups);
      for (const stamp of ['2100-01-01', '2100-01-02', '2100-01-03', '2100-01-04']) {
        mkdirSync(join(backups, stamp), { recursive: true });
        writeFileSync(join(backups, stamp, 'r-000001.md'), '<!-- retired: folded in -->\n', 'utf8');
      }

      expect(scan.backup()).toBeTruthy();
      const left = readdirSync(backups);
      // the five most recent whole-map snapshots survive: four seeded + the one just taken
      const snapshots = left.filter((e) => existsSync(join(backups, e, 'alethic.md')));
      expect(snapshots).toHaveLength(5);
      // …and every retired node is still there — retiring moves to .backup/, it does not delete
      expect(left.filter((e) => existsSync(join(backups, e, 'r-000001.md')))).toHaveLength(4);
    });
  });

  // ── Phase 6: migrating a map written before the unit became a feature (decision 56) ──────────
  // The map on disk is the source of truth, so an old map is neither abandoned nor thrown away:
  // its sentence-shaped nodes are folded into features that INHERIT their ids, because the id is
  // what history, `affects` edges and the drift log hang from.
  describe('migrate (old form → features)', () => {
    let old: string;

    /** A branch as a pre-decision-56 scan left it: the assertion is the title, the body is one line. */
    const writeOldForm = (root: string): void => {
      const dir = join(root, '.alethic', 'domains', 'cli', 'commands');
      mkdirSync(dir, { recursive: true });
      const ts = '2026-07-01T00:00:00Z';
      const base = {
        kind: 'rule' as const,
        status: 'ok' as const,
        provenance: 'agent' as const,
        locked: false,
        affects: [],
        tests: [],
        created: ts,
        updated: ts,
        updated_by: 'scanner' as const,
      };
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'cli.ts'),
        'export function cmdAdd(text: string): void {}\nexport function cmdList(): void {}\n',
        'utf8',
      );
      writeFileSync(
        join(root, '.alethic', 'alethic.md'),
        serialize({
          meta: {
            id: 'a-000001',
            kind: 'root',
            title: 'Old map',
            created: ts,
            updated: ts,
            updated_by: 'scanner',
          },
          body: 'A map from before the unit was a feature.',
        }),
        'utf8',
      );
      writeFileSync(
        join(root, '.alethic', 'domains', 'cli', '_domain.md'),
        serialize({
          meta: {
            id: 'd-000001',
            kind: 'domain',
            title: 'Cli',
            scope: ['src/**'],
            created: ts,
            updated: ts,
            updated_by: 'scanner',
          },
          body: 'The command-line surface.',
        }),
        'utf8',
      );
      writeFileSync(
        join(dir, '_sub.md'),
        serialize({
          meta: {
            id: 's-000001',
            kind: 'sub',
            title: 'Commands',
            created: ts,
            updated: ts,
            updated_by: 'scanner',
          },
          body: 'The commands.',
        }),
        'utf8',
      );
      const anchors = [{ file: 'src/cli.ts', symbol: 'cmdAdd', hash: 'blake3:1111111111111111' }];
      writeFileSync(
        join(dir, 'add-persists-the-list-before-printing.md'),
        serialize({
          meta: {
            ...base,
            id: 'r-000001',
            title: 'Add persists the full task list before printing.',
            anchors,
          },
          body: 'It writes the list, then prints the confirmation.',
        }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'adds-confirmation-line-prints-the-id.md'),
        serialize({
          meta: {
            ...base,
            id: 'r-000002',
            title: "`add`'s confirmation line prints the id",
            anchors,
          },
          body: 'The confirmation names the new id.',
        }),
        'utf8',
      );
    };

    beforeEach(() => {
      old = mkdtempSync(join(tmpdir(), 'alethic-legacy-'));
      writeOldForm(old);
      scan.setProject(old);
    });
    afterEach(() => rmSync(old, { recursive: true, force: true }));

    it('hands the agent the whole branch and its ids, and snapshots before touching it', async () => {
      expect(await scan.migrate('s-000001', 'claude-sonnet-5')).toEqual({ started: false }); // see below
      const prompt = engine.tasks.at(-1)!.prompt;
      expect(prompt).toContain('Migrate the branch "Commands"');
      expect(prompt).toContain('r-000001 — "Add persists the full task list before printing."');
      expect(prompt).toContain('r-000002');
      expect(prompt).toContain('src/cli.ts · cmdAdd');
      expect(prompt).toContain('alethic_upsert_rule(id: <the id of the node it grew out of>');
      expect(readdirSync(join(old, '.alethic', '.backup'))).toHaveLength(1); // decision 43
    });

    // The pass above "failed": the fake engine wrote nothing, so the old nodes are still there.
    // That is the point — a migration that leaves both forms standing must not report success,
    // because a branch holding sentences next to features is precisely what it exists to prevent.
    it('refuses to call a half-migrated branch done', async () => {
      progress.length = 0;
      await scan.migrate('s-000001', 'claude-sonnet-5');
      expect(progress.at(-1)).toMatchObject({ phase: 'error' });
      expect(progress.at(-1)!.message).toMatch(/still in the old form/);
      expect(progress.at(-1)!.message).toContain(
        'Add persists the full task list before printing.',
      );
    });

    it('reports done once the branch really holds features, with the ids carried over', async () => {
      // An engine that does what the prompt asks: fold the two sentences into one feature that
      // inherits r-000001, and retire the node it absorbed.
      const folding: AgentEngine = {
        async *run(task: AgentTask): AsyncIterable<AgentEvent> {
          const store = new SpecStore(join(old, '.alethic'), () => '2026-08-08T00:00:00Z');
          await store.upsertRule({
            id: 'r-000001',
            path: ['cli', 'commands'],
            title: 'Adding a task',
            body: [
              '`todo add <text>` stores a task and confirms it in one line.',
              '',
              '## How it works',
              'cmdAdd writes the list before printing.',
              '',
              '## Invariants',
              '- the list is persisted before the confirmation is printed',
              '- the confirmation names the new id',
            ].join('\n'),
            anchors: [{ file: 'src/cli.ts', symbol: 'cmdAdd' }],
          });
          store.retireRule('r-000002', 'folded into Adding a task (r-000001)');
          expect(task.role).toBe('scanner');
          yield { type: 'done', ok: true };
        },
      };
      const migrator = new ScanService(folding, () => '2026-08-08T00:00:00Z');
      const seen: ScanProgress[] = [];
      migrator.onProgress((p) => seen.push(p));
      migrator.setProject(old);

      expect(await migrator.migrate('s-000001', 'claude-sonnet-5')).toEqual({ started: true });
      expect(seen.at(-1)).toMatchObject({ phase: 'done' });
      expect(migrator.legacyUnder()).toEqual([]);
      // the id survived the regrouping — history, affects and the drift log hang from it
      const written = readFileSync(
        join(old, '.alethic', 'domains', 'cli', 'commands', 'adding-a-task.md'),
        'utf8',
      );
      expect(written).toContain('id: "r-000001"');
      expect(written).toContain('## Invariants'); // the old sentences live on as invariants
      expect(
        existsSync(
          join(
            old,
            '.alethic',
            'domains',
            'cli',
            'commands',
            'adds-confirmation-line-prints-the-id.md',
          ),
        ),
      ).toBe(false);
    });

    it('counts what is still in the old form, per branch and for the whole map', () => {
      expect(scan.legacyUnder().map((n) => n.id)).toEqual(['r-000001', 'r-000002']);
      expect(scan.legacyUnder('domains/cli/commands/_sub.md')).toHaveLength(2);
      expect(scan.legacyUnder('domains/auth/_domain.md')).toEqual([]);
    });

    it('a feature is not a branch: migration regroups the nodes under a container', async () => {
      progress.length = 0;
      expect(await scan.migrate('r-000001', 'claude-sonnet-5')).toEqual({ started: false });
      expect(progress.at(-1)!.message).toMatch(/is not a branch/);
      expect(engine.tasks).toHaveLength(0); // nothing was sent to the model
    });
  });

  it('picks the three most central rules for post-scan calibration (decision 40)', () => {
    const acme = new ScanService(engine);
    acme.setProject(ACME);
    const top = acme.calibrationRules();
    expect(top).toHaveLength(3);
    expect(top[0]).toHaveProperty('title');
    expect(top[0]!.path).toMatch(/^domains\//);
  });
});
