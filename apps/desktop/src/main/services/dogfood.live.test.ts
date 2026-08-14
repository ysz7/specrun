// Live dog-food harness (Phase 2). NOT part of `pnpm test`: it drives the real flows against a
// real Claude session, so it is skipped unless ALETHIC_DOGFOOD is set — run it with `pnpm dogfood`.
// It is the Phase-2 substitute for a formal eval harness: three scenarios that exercise the whole
// product surface headlessly (no Electron), print what actually landed in the map, and assert the
// contract each role promises. Everything happens in a temp directory; the repo itself is only ever
// copied, never written to.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorFor,
  auditForm,
  loadAlethicDir,
  parsePlanPhases,
  serialize,
  titleNormViolation,
  validateDir,
  type LoadedNode,
} from '@alethic/format';
import { SdkAgentEngine, SpecStore } from '@alethic/agent';
import type { PlanProgress } from '@alethic/ipc';
import { AgentService } from './agent.service';
import { GitService } from './git.service';
import { PlanService } from './plan.service';
import { PlanningFlow } from './planning-flow';
import { ScanService } from './scan.service';
import { SyncService } from './sync.service';

const LIVE = !!process.env['ALETHIC_DOGFOOD'];
const MODEL = process.env['ALETHIC_MODEL'] ?? 'claude-sonnet-5';
const MINUTES = 60_000;

/** One scenario's harness: the same three objects main/index.ts composes, on a real SDK engine. */
function harness(root: string): {
  flow: PlanningFlow;
  agent: AgentService;
  plan: PlanService;
  progress: PlanProgress[];
  /** True once `n` agent runs have finished (a run ends with `done` or `error`). */
  settled: (n: number) => boolean;
  errors: string[];
  text: () => string;
  /** Tool calls in the order they were made — decision 56 asks the scanner to read before it writes. */
  tools: string[];
} {
  const agent = new AgentService(new SdkAgentEngine(), join(root, '.logs'));
  const plan = new PlanService();
  const flow = new PlanningFlow(agent, plan);
  const progress: PlanProgress[] = [];
  const errors: string[] = [];
  const tools: string[] = [];
  let finished = 0;
  let transcript = '';
  plan.setProject(root);
  agent.setProject(root);
  plan.onProgress((p) => {
    progress.push(p);
    console.log(`      · ${p.phase}${p.message ? ` — ${p.message}` : ''}`);
  });
  agent.onEvent((e) => {
    flow.handleAgentEvent(e);
    if (e.type === 'text') transcript += e.text;
    if (e.type === 'tool') {
      tools.push(e.name);
      console.log(`      → ${e.name}`);
    }
    if (e.type === 'error') {
      errors.push(e.message);
      console.log(`      ⚠ ${e.message}`);
    }
    if (e.type === 'done' || e.type === 'error') finished += 1;
  });
  // The user clicking Allow: every run is sandboxed in a temp directory.
  agent.onPermission((r) => agent.respondPermission(r.requestId, true));
  // `finished`, not "no active task": a queued run has not started yet, so an idle queue at t=0
  // would otherwise read as "everything already completed".
  return {
    flow,
    agent,
    plan,
    progress,
    errors,
    settled: (n) => finished >= n && agent.activeTask().taskId === null,
    text: () => transcript,
    tools,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, polling — live runs take minutes, not ticks. */
async function until(what: string, done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what} after ${Math.round(timeoutMs / 1000)}s`);
}

const nodesOf = (root: string): LoadedNode[] => loadAlethicDir(join(root, '.alethic')).nodes;
const kind = (nodes: LoadedNode[], k: string): LoadedNode[] =>
  nodes.filter((n) => n.meta?.kind === k);

/** Every source file under a directory, repo-relative — for "did the phase actually write code". */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '.alethic' || entry === '.logs' || entry === 'node_modules' || entry === '.git')
      continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

function banner(title: string): void {
  console.log(`\n  ── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

describe.skipIf(!LIVE)('dog-food: the real flows on a real Claude session', () => {
  const dirs: string[] = [];
  const tmpProject = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  beforeAll(() => {
    console.log(`\n  model: ${MODEL}`);
  });
  afterAll(() => {
    // Keep the produced maps when asked (ALETHIC_DOGFOOD_KEEP=1) — they are the run's evidence.
    if (process.env['ALETHIC_DOGFOOD_KEEP']) {
      console.log(`\n  kept: ${dirs.join('\n         ')}\n`);
      return;
    }
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        console.log(`      (could not remove ${d} — a child process may still hold it)`);
      }
    }
  });

  it(
    'plan mode: a non-code plan comes back as filled notes, not as a to-do list',
    async () => {
      const root = tmpProject('dogfood-plan-');
      banner('plan mode — greenfield');
      const h = harness(root);
      h.flow.startBuilding(
        'A three-day trip to Lviv in October for two people: coffee, architecture, ~500 EUR total. ' +
          'I want the actual itinerary, not a list of things to research.',
        MODEL,
        'plan',
      );
      await until('the plan-author run', () => h.settled(1), 15 * MINUTES);
      await sleep(1000);
      expect(h.errors).toEqual([]);

      const nodes = nodesOf(root);
      const notes = kind(nodes, 'note');
      const root_ = kind(nodes, 'root')[0];
      console.log(`      thesis: ${(root_?.body ?? '').slice(0, 120)}…`);
      for (const n of notes)
        console.log(
          `      note ${n.path} — ${n.body.trim().length} chars: ${n.body.trim().slice(0, 70)}…`,
        );

      expect(notes.length).toBeGreaterThanOrEqual(3);
      expect((root_?.body ?? '').length).toBeGreaterThan(80); // a real thesis, not a placeholder
      // Substance, not stubs: a note body that is one line is a description of work, not content.
      const thin = notes.filter((n) => n.body.trim().length < 200);
      expect(thin.map((n) => n.path)).toEqual([]);
      // Plan mode writes content only — no dev artefacts (decision 54).
      expect(kind(nodes, 'rule')).toHaveLength(0);
      expect(kind(nodes, 'plan')).toHaveLength(0);
      // And it nests: the pyramid is not a flat pile.
      expect(notes.some((n) => n.path.split('/').length > 3)).toBe(true);
      expect(validateDir(join(root, '.alethic'), root).errors).toBe(0);
    },
    20 * MINUTES,
  );

  it(
    'dev v2: greenfield plans one document, then a phase builds and lands in the map',
    async () => {
      const root = tmpProject('dogfood-dev-');
      banner('dev v2 — greenfield plan');
      const h = harness(root);
      h.flow.startBuilding(
        'A tiny Python CLI to-do app: `todo add <text>`, `todo list`, `todo done <n>`, stored in a ' +
          'JSON file next to the script. Pytest for the tests, no external dependencies.',
        MODEL,
        'dev',
      );
      await until('the planner run', () => h.settled(1), 15 * MINUTES);
      await sleep(1000);
      expect(h.errors).toEqual([]);

      const plans = kind(nodesOf(root), 'plan');
      expect(plans).toHaveLength(1); // ONE living document (decision 55)
      const planNode = plans[0]!;
      const phases = parsePlanPhases(planNode.body);
      for (const p of phases)
        console.log(`      ${p.title} — ${p.items.length} items${p.done ? ' ✓' : ''}`);
      expect(phases.length).toBeGreaterThanOrEqual(2);
      expect(phases[0]!.items.length).toBeGreaterThanOrEqual(2);
      expect(phases.every((p) => p.items.length > 0)).toBe(true);
      // No per-step files, and the plan is not a wall of unphased prose.
      expect(kind(nodesOf(root), 'plan-step')).toHaveLength(0);

      banner('dev v2 — execute phase 1');
      const started = h.flow.executePhase(planNode.meta!.id, 0, MODEL);
      expect(started).toEqual({ started: true });
      await until(
        'phase 1 to land and its code to be mapped',
        () => h.progress.some((p) => p.phase === 'done' || p.phase === 'blocked'),
        30 * MINUTES,
      );
      await sleep(1000);

      const files = walk(root);
      console.log(`      files written: ${files.join(', ')}`);
      const after = nodesOf(root);
      const phase1 = parsePlanPhases(after.find((n) => n.meta?.id === planNode.meta!.id)!.body)[0]!;
      console.log(`      phase note: ${phase1.note}`);
      for (const r of kind(after, 'rule')) console.log(`      rule ${r.path}: ${r.meta!.title}`);

      // the phase actually built something, including a test
      expect(files.some((f) => f.endsWith('.py'))).toBe(true);
      expect(files.some((f) => /test/i.test(f))).toBe(true);
      // …and the deterministic finalization ran: ticks + one outcome line + rules from the code
      expect(phase1.done).toBe(true);
      expect(phase1.note).toMatch(/^done \d{4}-\d{2}-\d{2}/);
      expect(kind(after, 'rule').length).toBeGreaterThan(0);
      // What the code-map pass wrote is features, not sentences (decision 56). Phase 6 task 3: the
      // post-phase map runs the same scanner as a scan, so it owes the same unit — a name for a
      // title AND a body with sections, not just a title that happens to pass the norm.
      expect(
        kind(after, 'rule')
          .map((r) => r.meta!.title)
          .filter((t) => titleNormViolation(t) !== null),
      ).toEqual([]);
      expect(auditForm(after).legacy.map((l) => `${l.path}: ${l.reason}`)).toEqual([]);
      expect(validateDir(join(root, '.alethic'), root).errors).toBe(0);
    },
    50 * MINUTES,
  );

  it(
    'own repo: the code-map pass describes Alethic’s own code with anchors that resolve',
    async () => {
      const root = tmpProject('dogfood-self-');
      banner('own repo — code map over packages/format');
      // A slice of this repository, copied so the agent can never touch the original.
      const src = join(process.cwd(), 'packages', 'format', 'src');
      cpSync(src, join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'alethic-format-slice', private: true, type: 'module' }, null, 2),
      );
      mkdirSync(join(root, '.alethic'), { recursive: true });
      const h = harness(root);
      h.plan.ensureRoot('dev');

      h.flow.mapCode(MODEL);
      await until('the scanner run', () => h.settled(1), 30 * MINUTES);
      await sleep(1000);
      expect(h.errors).toEqual([]);

      const nodes = nodesOf(root);
      const rules = kind(nodes, 'rule');
      for (const r of rules)
        console.log(
          `      ${r.path}: ${r.meta!.title} → ${(r.meta as { anchors?: { file: string; symbol?: string }[] }).anchors?.map((a) => `${a.file}${a.symbol ? `#${a.symbol}` : ''}`).join(', ')}`,
        );
      expect(rules.length).toBeGreaterThanOrEqual(4);
      expect(kind(nodes, 'domain').length).toBeGreaterThanOrEqual(1);

      // The map is read before it is written (decision 56 / the constitution): the scanner
      // continues the map that exists instead of describing files from scratch.
      const firstWrite = h.tools.findIndex((t) => t.includes('upsert_rule'));
      const firstRead = h.tools.findIndex((t) => t.includes('read_map'));
      expect(firstRead).toBeGreaterThanOrEqual(0);
      expect(firstRead).toBeLessThan(firstWrite);

      // Anchors must point at code that exists — a hallucinated file is the failure that costs trust.
      const missing: string[] = [];
      for (const r of rules)
        for (const a of (r.meta as { anchors: { file: string }[] }).anchors)
          if (!existsSync(join(root, a.file))) missing.push(`${r.meta!.id} → ${a.file}`);
      expect(missing).toEqual([]);
      const validation = validateDir(join(root, '.alethic'), root);
      console.log(`      validation: ${validation.errors} errors, ${validation.warnings} warnings`);
      expect(validation.errors).toBe(0);
      // The map must describe what the code DOES, not restate the file listing.
      const titles = rules.map((r) => r.meta!.title);
      expect(titles.filter((t) => t.toLowerCase().includes('.ts')).length).toBe(0);

      // …and it must be a map of FEATURES (decision 56): every node is named, not a sentence, and
      // its body carries the feature's structure rather than a single line.
      const badTitles = titles.filter((t) => titleNormViolation(t) !== null);
      expect(badTitles).toEqual([]);
      expect(
        validation.issues.filter(
          (i) => i.code === 'title-not-a-name' || i.code === 'container-too-wide',
        ),
      ).toEqual([]);
      const thin = rules.filter((r) => r.body.trim().length < 200 || !/^##\s/m.test(r.body));
      expect(thin.map((r) => `${r.path} (${r.body.trim().length} chars)`)).toEqual([]);
      // …which is the same thing the form audit says, from the other direction (Phase 6).
      expect(auditForm(nodes).legacy).toEqual([]);
    },
    45 * MINUTES,
  );
  // Phase 4 / decision 56: Deepen enriches the node it was fired on. The contract is checked in
  // unit tests; what only a real run can show is that the agent, given a node's own body, comes
  // back with a fuller version of THAT node — twice — instead of a fresh description or neighbours.
  it(
    'deepen: two passes enrich one feature and never breed neighbours',
    async () => {
      const root = tmpProject('dogfood-deepen-');
      banner('deepen — one feature, twice');
      const src = join(process.cwd(), 'packages', 'format', 'src', 'anchors');
      cpSync(src, join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'alethic-anchors-slice', private: true, type: 'module' }, null, 2),
      );
      mkdirSync(join(root, '.alethic'), { recursive: true });
      const h = harness(root);
      h.plan.ensureRoot('dev');

      // First build a small map to deepen into.
      h.flow.mapCode(MODEL);
      await until('the scanner run', () => h.settled(1), 30 * MINUTES);
      await sleep(1000);
      const mapped = kind(nodesOf(root), 'rule');
      expect(mapped.length).toBeGreaterThan(0);

      const scan = new ScanService(new SdkAgentEngine());
      scan.setProject(root);
      const target = mapped[0]!.meta!.id;
      const before = nodesOf(root).find((n) => n.meta?.id === target)!;
      console.log(
        `      deepening ${target} "${before.meta!.title}" (${before.body.trim().length} chars)`,
      );

      const sections = (body: string): string[] =>
        (body.match(/^##\s+.+$/gm) ?? []).map((s) => s.trim().toLowerCase());

      let previous = before;
      for (const pass of [1, 2]) {
        expect(await scan.deepen(target, MODEL)).toEqual({ started: true });
        const after = nodesOf(root);
        const node = after.find((n) => n.meta?.id === target)!;
        console.log(
          `      pass ${pass}: ${node.body.trim().length} chars, sections [${sections(node.body).join(', ')}], ${kind(after, 'rule').length} rules on the map`,
        );

        // the node grew, and it is still the same node saying the same thing
        expect(node.body.trim().length).toBeGreaterThan(previous.body.trim().length - 40);
        expect(sections(node.body).length).toBeGreaterThanOrEqual(2);
        // …no duplicated sections, however many passes ran
        expect(new Set(sections(node.body)).size).toBe(sections(node.body).length);
        // …the pass grew no neighbours: the map has the same nodes it had
        expect(kind(after, 'rule').length).toBe(mapped.length);
        // …and it kept the node's tie to the code (the first live run silently dropped it)
        const anchors = (node.meta as { anchors?: unknown[] }).anchors ?? [];
        expect(anchors.length).toBeGreaterThanOrEqual(
          ((before.meta as { anchors?: unknown[] }).anchors ?? []).length,
        );
        // …and the system recorded that this node has been read closely
        expect((node.meta as { depth?: string }).depth).toBe('full');
        expect(validateDir(join(root, '.alethic'), root).errors).toBe(0);
        previous = node;
      }
    },
    60 * MINUTES,
  );

  // Phase 6 / decision 56: a map scanned before the unit changed is a column of sentence-shaped
  // nodes. What only a real run can show is that the agent, handed such a branch, folds it into
  // features that INHERIT the old ids and retires the rest — rather than writing fresh features
  // beside the sentences and leaving the branch holding both forms at once.
  it(
    'migrate: an old-form branch becomes features that keep their ids',
    async () => {
      const root = tmpProject('dogfood-migrate-');
      banner('migrate — old form → features');
      const src = join(process.cwd(), 'fixtures', 'golden', 'acme-commerce-src');
      cpSync(src, root, { recursive: true });

      // The branch as a pre-decision-56 scan left it: the assertion is the title, the body is one
      // line, one node per sentence. Written straight to disk — the tools reject this shape now.
      const alethicDir = join(root, '.alethic');
      const dir = join(alethicDir, 'domains', 'payments', 'pricing');
      mkdirSync(dir, { recursive: true });
      const ts = '2026-01-01T00:00:00Z';
      const card = (rel: string, meta: Record<string, unknown>, body: string): void =>
        writeFileSync(join(alethicDir, rel), serialize({ meta: meta as never, body }), 'utf8');
      card(
        'alethic.md',
        {
          id: 'a-000001',
          kind: 'root',
          title: 'acme-commerce',
          created: ts,
          updated: ts,
          updated_by: 'scanner',
        },
        'The living map of acme-commerce.',
      );
      card(
        join('domains', 'payments', '_domain.md'),
        {
          id: 'd-000001',
          kind: 'domain',
          title: 'Payments',
          scope: ['src/payments/**'],
          created: ts,
          updated: ts,
          updated_by: 'scanner',
        },
        'Everything about money leaving and returning.',
      );
      card(
        join('domains', 'payments', 'pricing', '_sub.md'),
        {
          id: 's-000001',
          kind: 'sub',
          title: 'Pricing',
          created: ts,
          updated: ts,
          updated_by: 'scanner',
        },
        'Pricing.',
      );
      const rule = (id: string, title: string, body: string, symbol: string): void =>
        card(
          join('domains', 'payments', 'pricing', `${id}.md`),
          {
            id,
            kind: 'rule',
            title,
            status: 'ok',
            provenance: 'agent',
            locked: false,
            anchors: [
              { file: 'src/payments/discounts.ts', symbol, hash: 'blake3:0000000000000000' },
            ],
            affects: [],
            tests: [],
            created: ts,
            updated: ts,
            updated_by: 'scanner',
          },
          body,
        );
      rule(
        'r-000001',
        'A discount applies to the subtotal before tax.',
        'The discount is subtracted first.',
        'applyDiscounts',
      );
      rule(
        'r-000002',
        'The discount percentage is capped at 30%.',
        'Anything higher is clamped.',
        'applyDiscounts',
      );
      rule(
        'r-000003',
        'Promo codes never stack with a campaign discount.',
        'Only one applies.',
        'applyDiscounts',
      );
      rule(
        'r-000004',
        'A zero-percent discount leaves the subtotal untouched.',
        'No rounding is applied.',
        'applyDiscounts',
      );

      const before = nodesOf(root);
      const auditBefore = auditForm(before);
      console.log(
        `      before: ${auditBefore.legacy.length}/${auditBefore.rules} nodes in the old form`,
      );
      expect(auditBefore.legacy).toHaveLength(4);

      const h = harness(root);
      const scan = new ScanService(new SdkAgentEngine());
      scan.setProject(root);
      expect(await scan.migrate('s-000001', MODEL)).toEqual({ started: true });
      await sleep(1000);
      expect(h.errors).toEqual([]);

      const after = nodesOf(root);
      const rules = kind(after, 'rule');
      for (const r of rules)
        console.log(`      ${r.path}: ${r.meta!.title} (${r.body.trim().length} chars)`);

      // Nothing of the old form is left standing — the service's own post-check already refused to
      // report success otherwise, so this is the assertion that the check is telling the truth.
      expect(auditForm(after).legacy).toEqual([]);
      expect(scan.legacyUnder()).toEqual([]);
      // The branch is a handful of features, not four sentences renamed one by one.
      expect(rules.length).toBeGreaterThanOrEqual(1);
      expect(rules.length).toBeLessThanOrEqual(4);
      // At least one old id survived as a feature: that is what carries the history, the `affects`
      // edges and the drift log through the regrouping.
      const oldIds = new Set(['r-000001', 'r-000002', 'r-000003', 'r-000004']);
      const kept = rules.map((r) => r.meta!.id).filter((id) => oldIds.has(id));
      console.log(`      ids carried over: ${kept.join(', ') || '(none — regression)'}`);
      expect(kept.length).toBeGreaterThan(0);
      // Everything absorbed went to `.backup/`, not to nowhere.
      const retired = readdirSync(join(alethicDir, '.backup'), { recursive: true }) as string[];
      expect(retired.some((p) => /r-00000\d\.md$/.test(String(p)))).toBe(true);
      // The old sentences live on inside the features, as invariants.
      expect(rules.some((r) => /##\s+Invariants/i.test(r.body))).toBe(true);
      // …and the branch's roof asserts something rather than naming the folder.
      const roof = after.find((n) => n.meta?.id === 's-000001');
      console.log(`      roof: ${roof?.body.trim().slice(0, 90)}…`);
      expect(roof!.body.trim().length).toBeGreaterThan(40);

      const validation = validateDir(alethicDir, root);
      console.log(`      validation: ${validation.errors} errors, ${validation.warnings} warnings`);
      expect(validation.errors).toBe(0);
    },
    45 * MINUTES,
  );

  // Plan Phase 4 task 1 ("break some code and watch drift find it"). The deterministic half (a
  // changed anchor → `stale`) and the Sync agent's tool contract are already unit-tested with a
  // fake engine (sync.service.test.ts); what only a real run can show is that Claude, reading an
  // actual behavioural change, renders a verdict instead of waving it through as cosmetic.
  it(
    'sync: a real behavioural code change gets judged and logged as drift',
    async () => {
      const root = tmpProject('dogfood-sync-');
      banner('sync — break code, watch drift get judged');
      const src = join(process.cwd(), 'fixtures', 'golden', 'acme-commerce-src');
      cpSync(src, root, { recursive: true });

      const alethicDir = join(root, '.alethic');
      mkdirSync(alethicDir, { recursive: true });
      const ts = '2026-01-01T00:00:00Z'; // fixed past clock, so mtime always reads as "after"
      writeFileSync(
        join(alethicDir, 'alethic.md'),
        `---\nid: a-000001\nkind: root\ntitle: acme-commerce\ncreated: ${ts}\nupdated: ${ts}\nupdated_by: scanner\n---\n\nThe living map of acme-commerce.\n`,
      );

      const DISCOUNTS = 'src/payments/discounts.ts';
      const source = readFileSync(join(root, DISCOUNTS), 'utf8');
      const anchor = await anchorFor(DISCOUNTS, source, 'applyDiscounts');
      const store = new SpecStore(alethicDir, () => ts);
      await store.upsertRule(
        {
          id: 'r-000001',
          domain: 'payments',
          sub: 'pricing',
          title: 'Percentage-only discounting',
          body: 'The discounted subtotal is exactly `subtotal * (1 - pct)` — no extra reduction is applied beyond the requested discount percentage.',
          status: 'ok',
          anchors: [anchor!],
        },
        'scanner',
      );

      const engine = new SdkAgentEngine();
      const sync = new SyncService(engine, new GitService(), () => ts);
      sync.setProject(root);

      const baseline = await sync.sync(MODEL);
      expect(baseline.staleCount).toBe(0); // establishes the mtime baseline, finds nothing yet

      // A genuine behavioural change — an extra 10% off — not a rename or a comment edit.
      const edited = source.replace(
        'order.subtotal * (1 - pct)',
        'order.subtotal * (1 - pct) * 0.9',
      );
      expect(edited).not.toBe(source);
      writeFileSync(join(root, DISCOUNTS), edited);

      const result = await sync.sync(MODEL);
      console.log(
        `      sync: staleCount=${result.staleCount} staleAt=[${result.staleAt.join('; ')}]`,
      );
      expect(result.staleCount).toBe(1);

      const after = nodesOf(root);
      const rule = after.find((n) => n.meta?.id === 'r-000001')!;
      console.log(`      verdict: status=${(rule.meta as { status: string }).status}`);
      console.log(`      body:\n${rule.body}`);
      // The deterministic layer found it (stale); the live Sync agent then had to judge it — a
      // real behavioural change must not be waved through as "ok" (decision 18).
      expect((rule.meta as { status: string }).status).toBe('drift');
      expect(rule.body).toMatch(/##\s+Drift log/);
      expect(validateDir(alethicDir, root).errors).toBe(0);
    },
    10 * MINUTES,
  );
});

// A guard for the non-live run: without ALETHIC_DOGFOOD this file must cost nothing.
describe('dog-food harness', () => {
  it('is skipped unless ALETHIC_DOGFOOD is set', () => {
    expect(LIVE || readFileSync(__filename, 'utf8').includes('describe.skipIf(!LIVE)')).toBe(true);
  });
});
