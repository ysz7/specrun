// SyncService — liveness (Phase 7): the map is not allowed to lie silently. On a Sync trigger it
//   1. asks GitService what changed since last_sync_commit (mtime fallback without git),
//   2. runs the deterministic hash-checker (system) → marks the touched rules `stale`,
//   3. auto-runs the Sync agent on each stale rule to render a verdict immediately (decision 18).
// It also builds the "Update spec from code" / "Mark as regression" agent tasks (decisions 14, 28)
// and persists last_sync_commit + annotations-changed flags in .alethic/state.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDrift,
  describeDrift,
  loadAlethicDir,
  type LoadedNode,
  type RuleDrift,
  type RuleMeta,
} from '@alethic/format';
import { SpecStore, type AgentEngine } from '@alethic/agent';
import type { SyncProgress, SyncResult } from '@alethic/ipc';
import { GitService } from './git.service';

interface SyncState {
  last_sync_commit?: string;
  last_sync_time?: string;
  annotations_changed?: string[]; // rule ids with only-comment changes, pending a piggyback review
}

/** A prepared agent task for a drift resolution action, handed to the AgentService to stream. */
export interface DriftTask {
  role: 'scanner' | 'planner';
  prompt: string;
}

type ProgressListener = (progress: SyncProgress) => void;

const nowIso = (): string => new Date().toISOString();

export class SyncService {
  private root: string | null = null;
  private running = false;
  private emitProgress: ProgressListener = () => {};

  constructor(
    private readonly engine: AgentEngine,
    private readonly git: GitService = new GitService(),
    private readonly clock: () => string = nowIso,
  ) {}

  onProgress(listener: ProgressListener): void {
    this.emitProgress = listener;
  }
  setProject(root: string | null): void {
    this.root = root;
  }
  private requireRoot(): string {
    if (!this.root) throw new Error('No project is open.');
    return this.root;
  }
  private alethicDir(): string {
    return join(this.requireRoot(), '.alethic');
  }

  // ── state.json ─────────────────────────────────────────────────────────
  private readState(): SyncState {
    const path = join(this.alethicDir(), 'state.json');
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SyncState;
    } catch {
      return {};
    }
  }
  private writeState(state: SyncState): void {
    writeFileSync(join(this.alethicDir(), 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * A full sync pass. Detects drift deterministically, marks rules stale, then judges each stale
   * rule with the Sync agent. Returns a small result for a passive banner (decision 15).
   */
  async sync(model: string): Promise<SyncResult> {
    if (this.running)
      return {
        ran: false,
        method: 'none',
        changedFiles: 0,
        staleCount: 0,
        annotationsChanged: 0,
        rescanDomains: [],
        staleAt: [],
      };
    const root = this.requireRoot();
    if (!existsSync(join(this.alethicDir(), 'alethic.md')))
      return {
        ran: false,
        method: 'none',
        changedFiles: 0,
        staleCount: 0,
        annotationsChanged: 0,
        rescanDomains: [],
        staleAt: [],
      };

    this.running = true;
    this.emitProgress({ phase: 'checking', completed: 0, total: 0 });
    try {
      const { nodes } = loadAlethicDir(this.alethicDir());
      const anchoredFiles = anchoredFilesOf(nodes);
      const state = this.readState();
      const since = state.last_sync_commit ?? null;

      // 1. what changed on disk
      const gitChanged = this.git.changedSince(root, since);
      const method: SyncResult['method'] = gitChanged ? 'git' : 'mtime';
      const changed =
        gitChanged ??
        this.git.changedByMtime(root, [...anchoredFiles], state.last_sync_time ?? null);

      // only files that actually anchor a rule matter for drift
      const sources = new Map<string, string | null>();
      for (const file of changed.files) {
        if (!anchoredFiles.has(file)) continue;
        try {
          sources.set(file, readFileSync(join(root, file), 'utf8'));
        } catch {
          sources.set(file, null);
        }
      }
      for (const file of changed.deleted) if (anchoredFiles.has(file)) sources.set(file, null);

      // 2. deterministic hash check → stale (system)
      const report = await checkDrift(nodes, sources);
      const store = new SpecStore(this.alethicDir(), this.clock);
      const statusById = new Map(
        nodes
          .filter((n): n is LoadedNode & { meta: RuleMeta } => n.meta?.kind === 'rule')
          .map((n) => [n.meta.id, n.meta.status]),
      );
      let staleCount = 0;
      for (const id of report.stale) {
        const current = statusById.get(id);
        if (current !== 'ok' && current !== 'drift') continue; // already stale/drift-of-note
        try {
          store.setStatus(id, 'stale', 'system');
          staleCount += 1;
        } catch {
          /* a rule may have been retired between load and write */
        }
      }

      // 3. persist state (commit pointer + annotation flags, §5.4)
      const pendingAnnotations = new Set([
        ...(state.annotations_changed ?? []),
        ...report.annotationsChanged,
      ]);
      const head = this.git.head(root);
      this.writeState({
        ...(head ? { last_sync_commit: head } : {}),
        last_sync_time: this.clock(),
        annotations_changed: [...pendingAnnotations],
      });

      // 4. auto-verdicts (decision 18) — judge every rule now marked stale
      await this.judgeStale(root, model, report.stale, since, report.rules);

      // clear annotation flags for domains we just judged (piggyback, §5.4 / task 6)
      this.clearJudgedAnnotations(report.stale);

      this.emitProgress({
        phase: 'done',
        completed: report.stale.length,
        total: report.stale.length,
      });
      // What moved, per feature, in the words of the deterministic check — the banner would
      // otherwise say "3 newly stale" about nodes that stand for a dozen symbols each.
      const titleById = new Map(nodes.map((n) => [n.meta?.id ?? '', n.meta?.title ?? '']));
      const staleAt = report.rules
        .filter((d) => report.stale.includes(d.id))
        .map((d) => `${titleById.get(d.id) || d.id} — ${describeDrift(d)}`);
      return {
        ran: true,
        method,
        changedFiles: sources.size,
        staleCount,
        annotationsChanged: report.annotationsChanged.length,
        rescanDomains: report.rescanDomains,
        staleAt,
      };
    } catch (err) {
      this.emitProgress({
        phase: 'error',
        completed: 0,
        total: 0,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        ran: false,
        method: 'none',
        changedFiles: 0,
        staleCount: 0,
        annotationsChanged: 0,
        rescanDomains: [],
        staleAt: [],
      };
    } finally {
      this.running = false;
    }
  }

  /** Run the Sync agent once per stale rule; it sets ok / drift+log / drift+propose via MCP tools. */
  private async judgeStale(
    root: string,
    model: string,
    staleIds: readonly string[],
    since: string | null,
    drifts: readonly RuleDrift[] = [],
  ): Promise<void> {
    if (staleIds.length === 0) return;
    const driftById = new Map(drifts.map((d) => [d.id, d]));
    const { nodes } = loadAlethicDir(this.alethicDir());
    const state = this.readState();
    const pending = new Set(state.annotations_changed ?? []);
    const byDomainAnnotations = groupByDomain(nodes, [...pending]);

    let completed = 0;
    for (const id of staleIds) {
      const node = nodes.find((n) => n.meta?.id === id);
      if (!node?.meta || node.meta.kind !== 'rule') continue;
      // The unit is a feature now (decision 56), so "this node went stale" is a blunt signal: the
      // node may stand for a dozen symbols of which one moved. The deterministic checker already
      // knows which — say it, in the progress line and in the prompt, so the judge scopes its
      // verdict to the part of the feature that actually changed instead of re-reading all of it.
      const drift = driftById.get(id);
      const located = drift ? describeDrift(drift) : '';
      this.emitProgress({
        phase: 'judging',
        rule: node.meta.title,
        ...(located ? { message: located } : {}),
        completed,
        total: staleIds.length,
      });

      const anchors = node.meta.anchors;
      const moved = drift?.checks.filter((c) => c.verdict !== 'unchanged') ?? [];
      const files = [...new Set((moved.length ? moved : anchors).map((a) => a.file))];
      const diff = this.git.diff(root, since, files);
      const domain = domainOf(node.path);
      const piggyback = (byDomainAnnotations.get(domain) ?? []).filter((r) => r !== id);

      const prompt = [
        `Feature ${id} — "${node.meta.title}" — went stale: code it is anchored to changed. Return exactly one verdict.`,
        ``,
        `Feature body:\n${node.body}`,
        ``,
        `Anchors: ${anchors.map((a) => `${a.file}${a.symbol ? ` · ${a.symbol}` : ''}`).join(', ')}`,
        ...(moved.length
          ? [
              ``,
              `WHAT MOVED (the deterministic check, not a guess) — ${located}.`,
              `Judge that part of the feature. The statements in the untouched sections are not what this run is about:`,
              ...moved.map(
                (c) =>
                  `- ${c.symbol ?? c.file} — ${c.verdict}${c.place ? `, described in ${c.place}` : ', not named anywhere in the body'}`,
              ),
              `A feature holds many statements: say in your verdict WHICH of them the change breaks or leaves standing.`,
            ]
          : []),
        diff
          ? `\nDiff:\n${diff}`
          : `\n(No git diff available — read the current code at the anchors.)`,
        piggyback.length
          ? `\nComments also changed on sibling rules in this domain — review them on the same scale: ${piggyback.join(', ')}.`
          : ``,
        ``,
        `Act with the tools: cosmetic → alethic_set_status(${id}, "ok", "sync"). behavior-changed → alethic_log_drift then alethic_set_status(${id}, "drift", "sync"). rule-outdated → alethic_log_drift + alethic_set_status(${id}, "drift", "sync") + alethic_propose_edit.`,
        `The drift log entry must name the place inside the feature (the section, the symbol), not just the feature.`,
      ].join('\n');

      try {
        for await (const ev of this.engine.run({ role: 'sync', model, prompt, cwd: root })) {
          if (ev.type === 'done' || ev.type === 'error') break;
        }
      } catch {
        /* one rule's verdict failing must not abort the whole pass */
      }
      completed += 1;
    }
  }

  /** Drop annotation flags for the domains whose rules we just judged (they were piggybacked). */
  private clearJudgedAnnotations(judgedIds: readonly string[]): void {
    const state = this.readState();
    if (!state.annotations_changed?.length || judgedIds.length === 0) return;
    const { nodes } = loadAlethicDir(this.alethicDir());
    const judgedDomains = new Set(
      judgedIds
        .map((id) => nodes.find((n) => n.meta?.id === id)?.path)
        .filter((p): p is string => !!p)
        .map(domainOf),
    );
    const remaining = state.annotations_changed.filter((id) => {
      const node = nodes.find((n) => n.meta?.id === id);
      return node ? !judgedDomains.has(domainOf(node.path)) : false;
    });
    this.writeState({ ...state, annotations_changed: remaining });
  }

  /**
   * Build the "Update spec from code" agent task (decision 14). Unlocked/agent rules are rewritten
   * by the Scanner (drift→ok); locked/human rules can only be offered a diff via propose_edit —
   * the upsert tool will reject an overwrite, and the prompt tells the agent to propose instead.
   */
  buildUpdateFromCodeTask(nodeId: string): DriftTask | null {
    const node = this.findRule(nodeId);
    if (!node) return null;
    const { meta, path } = node;
    const [, domain = '', sub = ''] = path.split('/');
    const protectedBody = meta.locked || meta.provenance !== 'agent';
    const anchors = meta.anchors
      .map((a) => `${a.file}${a.symbol ? ` · ${a.symbol}` : ''}`)
      .join(', ');
    const prompt = protectedBody
      ? `Rule ${nodeId} — "${meta.title}" — has drifted and is ${meta.locked ? 'locked' : `human-authored`}. Re-read the anchored code (${anchors}) and, because the body is protected, call alethic_propose_edit(${nodeId}, <new body matching the code>). Do NOT overwrite it.`
      : `Rule ${nodeId} — "${meta.title}" — has drifted. Re-read the anchored code (${anchors}) and rewrite the rule to match reality: call alethic_upsert_rule with id "${nodeId}", domain "${domain}", sub "${sub}", status "ok", refreshed anchors, and a Drift log line noting the update. Keep it a behavioural assertion, not an implementation detail.`;
    return { role: 'scanner', prompt };
  }

  /**
   * Build the "Mark as regression" agent task (decision 28): the fix is planned as a phase of the
   * project's single living plan document (dev-planning v2, decision 55 — no per-step files).
   */
  buildRegressionTask(nodeId: string): DriftTask | null {
    const node = this.findRule(nodeId);
    if (!node) return null;
    const { meta } = node;
    const anchors = meta.anchors
      .map((a) => `${a.file}${a.symbol ? ` · ${a.symbol}` : ''}`)
      .join(', ');
    const prompt = `Rule ${nodeId} — "${meta.title}" — describes the intended behaviour, but the code drifted away from it and this is a regression, not a deliberate change. Plan the fix that restores the rule.

Read the project's plan document first, then call alethic_upsert_plan ONCE with its FULL body, extended by a phase at the end:

## Phase N — Fix: ${meta.title}
- [ ] <commit-sized item that changes the code at ${anchors} back to satisfy the rule>
- [ ] <the test that proves the rule holds again>

Reproduce every existing phase, item and [x] check verbatim — you are extending the document, not rewriting it. Do not edit the rule itself and do not write code.`;
    return { role: 'planner', prompt };
  }

  private findRule(nodeId: string): { meta: RuleMeta; path: string } | null {
    const { nodes } = loadAlethicDir(this.alethicDir());
    const node = nodes.find((n) => n.meta?.id === nodeId);
    if (!node?.meta || node.meta.kind !== 'rule') return null;
    return { meta: node.meta, path: node.path };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
const domainOf = (path: string): string => {
  const parts = path.split('/');
  return parts[0] === 'domains' ? (parts[1] ?? '') : '';
};

function anchoredFilesOf(nodes: readonly LoadedNode[]): Set<string> {
  const files = new Set<string>();
  for (const n of nodes) {
    if (n.meta?.kind === 'rule' || n.meta?.kind === 'plan-step') {
      for (const a of n.meta.anchors) files.add(a.file);
    }
  }
  return files;
}

function groupByDomain(
  nodes: readonly LoadedNode[],
  ids: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const node = nodes.find((n) => n.meta?.id === id);
    if (!node) continue;
    const d = domainOf(node.path);
    out.set(d, [...(out.get(d) ?? []), id]);
  }
  return out;
}
