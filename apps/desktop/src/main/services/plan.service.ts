// PlanService — Act 2 finale + Act 3, rebuilt for dev-planning v2 (decision 55). It builds the
// Planner task (one living plan document of phases + checkboxes) and the Executor task for a single
// phase; when a phase's run lands it ticks that phase's checkboxes and asks for a scanner pass that
// folds the new code into the Code branch — rules come from scanning code, not from promoting steps
// (this supersedes decisions 25/27/42's per-step pipeline). The agent runs themselves flow through
// AgentService so they keep the Claude-Code permission flow; PlanService correlates their
// completion by taskId and owns the deterministic finalization.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  genId,
  loadAlethicDir,
  parsePlanPhases,
  serialize,
  type LoadedNode,
  type PlanMeta,
  type RuleMeta,
} from '@alethic/format';
import { SpecStore } from '@alethic/agent';
import type { AgentStreamMessage, PlanProgress } from '@alethic/ipc';
import { GitService } from './git.service';

type ProgressListener = (progress: PlanProgress) => void;
type CodeMapListener = (request: CodeMapRequest) => void;

const nowIso = (): string => new Date().toISOString();

/** A running phase execution (dev-planning v2, decision 55), keyed by agent taskId. */
interface PendingPhase {
  planId: string;
  phaseIndex: number;
  phaseTitle: string;
  model: string; // reused for the code-map pass this phase triggers
  preCommit: string | null; // pre-execution state → which files the phase actually touched
  preTime: string;
  files?: string[]; // what the run touched, carried into the outcome note
  rulesBefore?: string[]; // rule ids before the code-map pass → what it added
}

/**
 * A scanner run that turns the code a phase just wrote into map rules (decision 55: rules come from
 * scanning code, not from promoting plan steps). PlanService builds it; the caller owns the agent.
 */
export interface CodeMapRequest {
  role: 'scanner';
  prompt: string;
  model: string;
  planId?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  files?: string[]; // what the phase touched — carried into its outcome note
  rulesBefore?: string[]; // rule ids before this pass, so we can name what it added
}

export class PlanService {
  private root: string | null = null;
  private readonly pendingPhases = new Map<string, PendingPhase>(); // taskId → pending phase run
  private readonly pendingMaps = new Map<string, PendingPhase>(); // taskId → phase whose code is being mapped
  private emitProgress: ProgressListener = () => {};
  private emitCodeMap: CodeMapListener = () => {};

  constructor(
    private readonly git: GitService = new GitService(),
    private readonly clock: () => string = nowIso,
  ) {}

  onProgress(listener: ProgressListener): void {
    this.emitProgress = listener;
  }
  /** Subscribe to code-map runs the service wants started (post-phase or on request). */
  onCodeMap(listener: CodeMapListener): void {
    this.emitCodeMap = listener;
  }
  setProject(root: string | null): void {
    this.root = root;
    this.pendingPhases.clear();
    this.pendingMaps.clear();
  }
  private requireRoot(): string {
    if (!this.root) throw new Error('No project is open.');
    return this.root;
  }
  private alethicDir(): string {
    return join(this.requireRoot(), '.alethic');
  }
  private store(): SpecStore {
    return new SpecStore(this.alethicDir(), this.clock);
  }

  // ── planning ─────────────────────────────────────────────────────────────

  /** The Planner task for a feature described in chat (creation streams through AgentService).
   * Dev-planning v2 (decision 55): ONE living plan document with phases + checkboxes; append, never
   * explode into per-step files. */
  buildPlanTask(message: string): { role: 'planner'; prompt: string } {
    const plan = this.planNode();
    const slug = plan ? (plan.path.split('/')[1] ?? 'roadmap') : 'roadmap';
    const upsert = plan
      ? `alethic_upsert_plan ONCE (id "${plan.meta!.id}", slug "${slug}")`
      : `alethic_upsert_plan ONCE (slug "roadmap")`;
    const current = plan
      ? [
          ``,
          `The plan document is .alethic/${plan.path}. Its phases today:`,
          ...parsePlanPhases(plan.body).map(
            (p) =>
              `- Phase ${p.index + 1} — ${p.title} (${p.items.filter((i) => i.done).length}/${p.items.length} done)`,
          ),
          `Read that file before writing so you keep every item verbatim.`,
        ].join('\n')
      : '';

    const prompt = `${this.mapSummary()}${current}

Request from the user:
${message}

Maintain the SINGLE project plan — the map has one living roadmap, never a second plan document. Call ${upsert} with the FULL updated body: a markdown checklist of phases —

## Phase 1 — <title>
- [ ] <commit-sized, verifiable item> (add tests where it makes sense)
- [x] <keep already-done items checked>
> ✓ <keep these outcome lines exactly as they are — the system wrote them>
## Phase 2 — <title>
- [ ] ...

Grow the plan: append the user's new work as extra items in the phase it belongs to, or as a new phase at the end. Reproduce every existing phase, item, [x] check and "> ✓" outcome line verbatim — you are extending the document, not rewriting it. Never write a "> ✓" line yourself; the system writes them when a phase lands. Do NOT create per-step files. Do not write code — you only plan.`;
    return { role: 'planner', prompt };
  }

  /** The project's single living plan document (decision 55), if it has one. */
  private planNode(): LoadedNode | undefined {
    try {
      const { nodes } = loadAlethicDir(this.alethicDir());
      return nodes.find((n) => n.meta?.kind === 'plan');
    } catch {
      return undefined;
    }
  }

  /**
   * Greenfield (decision 29): ensure a root exists, then a mode-appropriate task (decision 54).
   * dev → a Planner task (thesis + a phased plan document). plan → a Plan-Author task that writes
   * the thesis and fills real `note` content directly (no code, no plan/execute pipeline).
   */
  buildGreenfieldTask(
    description: string,
    mode: 'dev' | 'plan' = 'dev',
  ): { role: 'planner' | 'plan-author'; prompt: string } {
    this.ensureRoot(mode);
    if (mode === 'plan') {
      const prompt = `This is a new plan-mode project — an empty folder for planning something that is NOT software. The user wants to plan:
${description}

Call alethic_set_thesis with a one-paragraph apex thesis. Then build the pyramid with alethic_upsert_note: top-level sections first, then child notes under them (pass parent = the section note id). Write REAL, substantive content in every note body — the actual itinerary, recipe, analysis — never a description of work to be done. Do not write code.`;
      return { role: 'plan-author', prompt };
    }
    const prompt = `This is a greenfield software project — an empty folder. The user wants to build:
${description}

Write the plan as a SINGLE document (dev-planning v2) — do NOT create per-step files:
1. Call alethic_set_thesis with a one-paragraph apex thesis for the project.
2. Call alethic_upsert_plan ONCE (slug "roadmap", a one-line goal, the domains you foresee) whose body is a phased checklist in markdown:

## Phase 1 — <title>
- [ ] <commit-sized, verifiable item>
- [ ] <item> (include a test where it makes sense)
## Phase 2 — <title>
- [ ] ...

Phase 1 must be a runnable skeleton. Keep items commit-sized. Do not write code — you only plan.`;
    return { role: 'planner', prompt };
  }

  /** Read the project mode from config.yaml (decision 54); defaults to dev. */
  mode(): 'dev' | 'plan' {
    try {
      const { config } = loadAlethicDir(this.alethicDir());
      return config?.mode ?? 'dev';
    } catch {
      return 'dev';
    }
  }

  /** Persist the project mode into config.yaml (self-contained — writes a minimal config if absent). */
  setMode(mode: 'dev' | 'plan'): void {
    const dir = this.alethicDir();
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'config.yaml');
    const fallback =
      'format: 1\nlanguage: en\nstack: []\nscan:\n  include: ["**"]\n  exclude: []\nlimits:\n  max_rules_per_sub: 40\n';
    let text = existsSync(p) ? readFileSync(p, 'utf8') : fallback;
    text = /^mode:.*$/m.test(text)
      ? text.replace(/^mode:.*$/m, `mode: ${mode}`)
      : text.replace(/^(format:.*\r?\n)/m, `$1mode: ${mode}\n`);
    writeFileSync(p, text, 'utf8');
  }

  /**
   * Materialize the pyramid's two branches (decision 55) for a map that predates them: a project
   * with `plans/` or `domains/` on disk but no `_section.md` gets one on open. New writes create
   * their own section (SpecStore.ensureSection), so this only ever fires once per project.
   */
  ensureSections(): void {
    const dir = this.alethicDir();
    if (!existsSync(join(dir, 'alethic.md'))) return;
    const store = this.store();
    // Only for a tree that actually holds something: an empty `domains/` (greenfield seeds one, and
    // a plan-mode project never fills it) must not sprout a branch that says "this exists".
    const populated = (sub: string): boolean => {
      try {
        return readdirSync(join(dir, sub)).some((e) => e !== '_section.md');
      } catch {
        return false;
      }
    };
    if (populated('plans')) store.ensureSection('plan');
    if (populated('domains')) store.ensureSection('code');
  }

  /** Create `.alethic/` with a placeholder root if the project has no map yet (greenfield). */
  ensureRoot(mode: 'dev' | 'plan' = 'dev'): void {
    const dir = this.alethicDir();
    if (existsSync(join(dir, 'alethic.md'))) {
      this.setMode(mode);
      return;
    }
    mkdirSync(join(dir, 'domains'), { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      `format: 1\nmode: ${mode}\nlanguage: en\nstack: []\nscan:\n  include: ["**"]\n  exclude: []\nlimits:\n  max_rules_per_sub: 40\n`,
      'utf8',
    );
    const ts = this.clock();
    writeFileSync(
      join(dir, 'alethic.md'),
      serialize({
        meta: {
          id: genId('root'),
          kind: 'root',
          title: basename(this.requireRoot()),
          created: ts,
          updated: ts,
          updated_by: 'executor',
        },
        body: 'A new project — the thesis will be written as the plan takes shape.',
      }),
      'utf8',
    );
  }

  // ── execution: phases (dev-planning v2, decision 55) ───────────────────────

  /** Build an executor run for one phase of the roadmap plan; null if the plan/phase is missing. */
  preparePhase(
    planId: string,
    phaseIndex: number,
    model: string,
  ): ({ prompt: string } & PendingPhase) | null {
    const root = this.requireRoot();
    const { nodes } = loadAlethicDir(this.alethicDir());
    const planNode = nodes.find((n) => n.meta?.id === planId && n.meta.kind === 'plan');
    if (!planNode?.meta) return null;
    const phase = parsePlanPhases(planNode.body)[phaseIndex];
    if (!phase) return null;
    const goal = (planNode.meta as PlanMeta).goal;
    const open = phase.items.filter((i) => !i.done);
    const items = (open.length ? open : phase.items).map((i) => `- ${i.text}`).join('\n');
    // The rules of the plan's domains are guardrails the phase must not break (decision 26).
    const guardrails = this.guardrailRules(nodes, (planNode.meta as PlanMeta).domains ?? []);
    const prompt = [
      `Implement ONE phase of the project plan. Do not touch other phases or the .alethic/ plan document.`,
      goal ? `Project goal: ${goal}` : '',
      ``,
      `Phase ${phaseIndex + 1} — "${phase.title}". Items to implement:`,
      items,
      ``,
      guardrails.length
        ? `Rules the map already records for these domains — do not break them:\n${guardrails.map((g) => `- ${g}`).join('\n')}\n`
        : '',
      `Write the code and its tests, then run the tests via bash until they pass. If you can't make them pass in a few tries, stop and report what's blocking. Don't edit .alethic/. Report completion in your final message — the system will tick the phase's checkboxes and scan your code into the map.`,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      prompt,
      planId,
      phaseIndex,
      phaseTitle: phase.title,
      model,
      preCommit: this.git.head(root),
      preTime: this.clock(),
    };
  }

  /** Phases queued-or-running for a plan, so the UI can restore per-phase status after a remount. */
  pendingPhaseEntries(planId: string): { taskId: string; phaseIndex: number }[] {
    const out: { taskId: string; phaseIndex: number }[] = [];
    for (const [taskId, ph] of this.pendingPhases)
      if (ph.planId === planId) out.push({ taskId, phaseIndex: ph.phaseIndex });
    return out;
  }

  /** Register a running phase execution so its completion ticks the phase's checkboxes. */
  trackPhase(taskId: string, prep: PendingPhase): void {
    this.pendingPhases.set(taskId, prep);
    this.emitProgress({
      phase: 'executing',
      phaseIndex: prep.phaseIndex,
      phaseTitle: prep.phaseTitle,
    });
  }

  /** Register a running code-map pass so the phase row clears when the map catches up. */
  trackCodeMap(taskId: string, request: CodeMapRequest): void {
    if (request.planId === undefined || request.phaseIndex === undefined) return; // manual run: no phase row
    this.pendingMaps.set(taskId, {
      planId: request.planId,
      phaseIndex: request.phaseIndex,
      phaseTitle: request.phaseTitle ?? '',
      model: request.model,
      preCommit: null,
      preTime: this.clock(),
      ...(request.files ? { files: request.files } : {}),
      ...(request.rulesBefore ? { rulesBefore: request.rulesBefore } : {}),
    });
  }

  /** A code-map run on demand ("update the code map") — the whole working tree, no phase attached. */
  requestCodeMap(model: string): { started: boolean } {
    this.requireRoot();
    this.emitCodeMap({ role: 'scanner', prompt: this.buildCodeMapPrompt([], null), model });
    return { started: true };
  }

  /** The repo-relative files a phase touched; empty when git can't tell us (the prompt then asks
   * the scanner to find the new code itself). */
  private touchedFiles(pending: PendingPhase): string[] {
    const root = this.requireRoot();
    const changed = this.git.changedSince(root, pending.preCommit);
    return (changed?.files ?? []).filter((f) => !f.startsWith('.alethic/'));
  }

  /**
   * The scanner prompt that grows the Code branch: read the code (the phase's files, or the project
   * when we can't tell), record what it *does* as rules under existing domains, adding a domain only
   * when the code genuinely doesn't fit one. Coverage is never traded (constitution rule 7).
   */
  private buildCodeMapPrompt(files: readonly string[], phaseTitle: string | null): string {
    const scope = files.length
      ? `Files that changed:\n${files
          .slice(0, 60)
          .map((f) => `- ${f}`)
          .join('\n')}${files.length > 60 ? `\n- …and ${files.length - 60} more` : ''}`
      : `Look at the project's source files to find the code that is not in the map yet.`;
    return [
      phaseTitle
        ? `The plan phase "${phaseTitle}" just landed. Bring the code map up to date with it.`
        : `Bring the code map up to date with the current state of the code.`,
      ``,
      this.mapSummary(),
      ``,
      scope,
      ``,
      `Read the map itself first (alethic_read_map) — you are continuing it, not starting a second`,
      `one. Then read that code and record what it DOES with alethic_upsert_rule — one node per`,
      `FEATURE (decision 56: a named capability with a body — the statement, then`,
      `## How it works, ## Where it is used, ## Invariants — never one node per sentence),`,
      `anchored to the real symbols, in an existing domain where it fits (add a new domain only if`,
      `it genuinely belongs to none).`,
      `A feature that is already on the map is updated by its id, never duplicated beside itself.`,
      // A phase lands inside a branch that already has siblings, so this is where the eighth child
      // appears — the one place the width norm is easiest to breach without noticing.
      `If a container would end up with more than 7 children, group them into a layer instead:`,
      `alethic_move_rule the ones that belong together one level deeper, then give that layer a roof`,
      `with alethic_upsert_container whose body says what they have in common.`,
      `Every changed file must either inform a feature or be infrastructural — say`,
      `which in your final message. Do not write code and do not touch the plan document.`,
    ].join('\n');
  }

  /** Correlate agent completion → finalize a phase (tick its items) or its code-map pass. */
  handleAgentEvent(event: AgentStreamMessage): void {
    if (event.type !== 'done' && event.type !== 'error') return;
    const phase = this.pendingPhases.get(event.taskId);
    if (phase) {
      this.pendingPhases.delete(event.taskId);
      this.finishPhase(phase, event.type === 'done' && event.ok);
      return;
    }
    const mapped = this.pendingMaps.get(event.taskId);
    if (mapped) {
      this.pendingMaps.delete(event.taskId);
      // The map has caught up — rewrite the phase's outcome note, now that we know what it produced.
      this.writePhaseNote(mapped, this.newRules(mapped.rulesBefore ?? []));
      this.emitProgress({
        phase: 'done',
        phaseIndex: mapped.phaseIndex,
        phaseTitle: mapped.phaseTitle,
        message:
          event.type === 'done' && event.ok
            ? 'Code map updated.'
            : 'Phase done; the code map could not be updated — run it again from the Code branch.',
      });
    }
  }

  /** Rule ids currently in the map — the before/after pair tells us what a code-map pass added. */
  private ruleIds(): string[] {
    try {
      return loadAlethicDir(this.alethicDir())
        .nodes.filter((n) => n.meta?.kind === 'rule')
        .map((n) => n.meta!.id);
    } catch {
      return [];
    }
  }

  /** The rules a code-map pass added, as `<domain>/<sub>` labels for the outcome note. */
  private newRules(before: readonly string[]): string[] {
    const known = new Set(before);
    return loadAlethicDir(this.alethicDir())
      .nodes.filter((n) => n.meta?.kind === 'rule' && !known.has(n.meta.id))
      .map((n) => n.path.split('/').slice(1, 3).join('/'));
  }

  /**
   * Write the phase's outcome into the plan document itself (decision 55): finished work is
   * recorded next to the intent that asked for it, never as a separate node file. Called twice —
   * once the moment the phase lands (files), once when the code map catches up (rules) — and
   * setPhaseNote replaces rather than appends, so the phase carries exactly one line.
   */
  private writePhaseNote(pending: PendingPhase, mapped: readonly string[]): void {
    const parts = [`done ${this.clock().slice(0, 10)}`];
    const files = pending.files ?? [];
    if (files.length > 0) {
      const shown = files.slice(0, 6).join(', ');
      parts.push(
        `${files.length} file${files.length === 1 ? '' : 's'}: ${shown}${files.length > 6 ? `, +${files.length - 6} more` : ''}`,
      );
    }
    if (mapped.length > 0) {
      const where = [...new Set(mapped)].join(', ');
      parts.push(`${mapped.length} rule${mapped.length === 1 ? '' : 's'} mapped into ${where}`);
    }
    try {
      this.store().setPlanPhaseNote(pending.planId, pending.phaseIndex, parts.join(' · '));
    } catch {
      /* the plan was renamed or deleted mid-run — the checkboxes are the record that matters */
    }
  }

  /**
   * Finalize a phase run: on success tick its checkboxes and hand the caller a scanner run that
   * turns the code the phase just wrote into rules under the Code branch (decision 55). The old
   * step-level output guardrail (decision 42, rework on drift) does not apply here: a phase is
   * *meant* to change behaviour, so the map catches up by re-scanning instead of pushing back.
   */
  finishPhase(pending: PendingPhase, ok: boolean): void {
    try {
      if (ok) {
        const files = this.touchedFiles(pending);
        this.store().markPlanPhaseDone(pending.planId, pending.phaseIndex);
        this.writePhaseNote({ ...pending, files }, []); // visible immediately; enriched after mapping
        this.emitProgress({
          phase: 'mapping',
          phaseIndex: pending.phaseIndex,
          phaseTitle: pending.phaseTitle,
          message: `Phase ${pending.phaseIndex + 1} done — mapping the new code…`,
        });
        this.emitCodeMap({
          role: 'scanner',
          prompt: this.buildCodeMapPrompt(files, pending.phaseTitle),
          model: pending.model,
          planId: pending.planId,
          phaseIndex: pending.phaseIndex,
          phaseTitle: pending.phaseTitle,
          files,
          rulesBefore: this.ruleIds(),
        });
      } else {
        this.emitProgress({
          phase: 'blocked',
          phaseIndex: pending.phaseIndex,
          phaseTitle: pending.phaseTitle,
          message: `Phase ${pending.phaseIndex + 1} didn’t finish — check the chat.`,
        });
      }
    } catch (err) {
      this.emitProgress({
        phase: 'error',
        phaseIndex: pending.phaseIndex,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** One-line statements of the rules in the given domains, for the executor's guardrail block. */
  private guardrailRules(nodes: readonly LoadedNode[], domainIds: readonly string[]): string[] {
    const slugs = new Set(
      domainIds
        .map((id) => nodes.find((n) => n.meta?.id === id && n.meta.kind === 'domain'))
        .filter((n): n is LoadedNode => !!n)
        .map((n) => n.path.split('/')[1]),
    );
    return nodes
      .filter(
        (n): n is LoadedNode & { meta: RuleMeta } =>
          n.meta?.kind === 'rule' && slugs.has(n.path.split('/')[1]),
      )
      .map((n) => `${n.meta.title} (${n.meta.id}): ${firstLine(n.body)}`);
  }

  private mapSummary(): string {
    const { nodes } = loadAlethicDir(this.alethicDir());
    const domains = nodes.filter((n) => n.meta?.kind === 'domain');
    const rules = nodes.filter((n) => n.meta?.kind === 'rule');
    const lines = domains.map((d) => `- ${d.meta!.title} (${d.meta!.id})`);
    return [`[MAP] ${rules.length} rules across ${domains.length} domains.`, ...lines].join('\n');
  }
}

const firstLine = (body: string): string => (body.split('\n').find((l) => l.trim()) ?? '').trim();
