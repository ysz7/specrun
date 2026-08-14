// ScanService — the scan orchestrator (Phase 6): repo-map (0 tokens) → decomposition (1 call) →
// user-confirmed domains → per-domain sub-agents, 2–3 in parallel with rate-limit backoff.
// Coverage is never traded: every confirmed domain gets a card up front, and anything left
// unscanned (cancel, decision 36) is marked as such rather than silently missing.
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRepoMap, repoMapDigest, type RepoMap } from '@alethic/scan';
import {
  buildDecompositionPrompt,
  buildDeepenPrompt,
  buildMigrationPrompt,
  SpecStore,
  type AgentEngine,
  type DeepenTarget,
  type MigrationTarget,
} from '@alethic/agent';
import {
  auditForm,
  buildIndex,
  decodeHtmlEntities,
  genId,
  legacyFormViolation,
  loadAlethicDir,
  serialize,
  slugify,
  toIndexEntries,
} from '@alethic/format';
import type {
  CalibrationRule,
  DomainProposal,
  ScanActivity,
  ScanPreview,
  ScanProgress,
} from '@alethic/ipc';

const SIZE_THRESHOLD = 800; // decision 7: above this, deep scans are chosen and the rest go shallow
const CONCURRENCY = 3; // decision 9: 2–3 domain sub-agents in parallel
const BACKUPS_KEPT = 5; // decision 43
const NOT_SCANNED = '_Not scanned yet — run “Scan domain” to fill this in._';
// Windows-vs-POSIX has bitten this codebase twice before (PLAN.md); `relative()` answers with `\`
// on Windows, and every path this format speaks is posix.
const posix = (p: string): string => p.replace(/\\/g, '/');

type ProgressListener = (progress: ScanProgress) => void;
type CalibrationListener = (rules: CalibrationRule[]) => void;

const nowIso = (): string => new Date().toISOString();

export class ScanService {
  private root: string | null = null;
  private repoMap: RepoMap | null = null;
  private cancelled = false;
  private running = false;
  private activeDomain: string | null = null; // what the running pass is reading, for the UI
  private readonly aborts = new Set<AbortController>();
  private emitProgress: ProgressListener = () => {};
  private emitCalibration: CalibrationListener = () => {};

  constructor(
    private readonly engine: AgentEngine,
    private readonly clock: () => string = nowIso,
    // Same JSONL run-log directory AgentService writes into (PLAN.md known issues: constructed
    // with the engine directly, a scan pass used to leave nothing to diagnose a hang with — the
    // logs directory showed only chat and phase runs). Optional so tests that don't care about
    // logging don't need a directory to exist.
    private readonly logsDir?: string,
  ) {}

  onProgress(listener: ProgressListener): void {
    this.emitProgress = listener;
  }
  onCalibration(listener: CalibrationListener): void {
    this.emitCalibration = listener;
  }
  setProject(root: string | null): void {
    this.root = root;
    this.repoMap = null;
  }
  /**
   * Is a scan pass in flight? Asked on mount by anything that must not offer a second one — the
   * node card's Deepen/Rescan and the chat composer. Progress events keep them updated after that;
   * this is for the panel that opens mid-scan and would otherwise look idle.
   */
  active(): ScanActivity {
    return { running: this.running, ...(this.activeDomain ? { domain: this.activeDomain } : {}) };
  }

  private requireRoot(): string {
    if (!this.root) throw new Error('No project is open.');
    return this.root;
  }
  private alethicDir(): string {
    return join(this.requireRoot(), '.alethic');
  }

  /** Preview the cost before spending anything (decision 39) — repo-map is free. */
  async preview(): Promise<ScanPreview> {
    const root = this.requireRoot();
    this.emitProgress({ phase: 'repo-map', completed: 0, total: 0 });
    const map = (this.repoMap ??= await buildRepoMap(root));
    const domains: DomainProposal[] = map.domains.map((d) => ({
      slug: d.slug,
      title: d.title,
      scope: d.scope,
    }));
    const sourceFiles = map.files.filter((f) => f.lang).length;
    return {
      root,
      files: sourceFiles,
      domains,
      estimatedCalls: 1 + Math.max(domains.length, 1), // 1 decomposition + 1 per domain
      large: sourceFiles > SIZE_THRESHOLD,
      threshold: SIZE_THRESHOLD,
    };
  }

  /** One LLM call: propose domains from the repo-map. Falls back to the deterministic candidates. */
  async decompose(model: string): Promise<DomainProposal[]> {
    const root = this.requireRoot();
    const map = (this.repoMap ??= await buildRepoMap(root));
    const fallback: DomainProposal[] = map.domains.map((d) => ({
      slug: d.slug,
      title: d.title,
      scope: d.scope,
    }));
    this.emitProgress({ phase: 'decompose', completed: 0, total: 1 });

    const prompt = `${buildDecompositionPrompt(repoMapDigest(map))}\n\nReply with ONLY a JSON array: [{"slug":"...","title":"...","description":"...","scope":["glob"]}]`;
    let text = '';
    try {
      for await (const event of this.engine.run({ role: 'scanner', model, prompt, cwd: root })) {
        if (event.type === 'text') text += event.text;
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch {
      return fallback;
    }
    const parsed = parseDomainJson(text);
    return parsed && parsed.length > 0 ? parsed : fallback;
  }

  /** Run the scan: seed every domain card, then scan them in parallel. */
  async start(
    model: string,
    domains: DomainProposal[],
    deep: string[] = [],
  ): Promise<{ started: boolean }> {
    if (this.running) return { started: false };
    const root = this.requireRoot();
    this.running = true;
    this.cancelled = false;

    try {
      this.ensureAlethic(root);
      const deepSet = new Set(deep.length > 0 ? deep : domains.map((d) => d.slug));
      // Seed all cards first — the map shows 100% of the domains from the first second.
      for (const [i, domain] of domains.entries()) {
        this.writeDomainCard(domain, deepSet.has(domain.slug) ? 'full' : 'shallow', i + 1, true);
      }

      const total = domains.length;
      let completed = 0;
      this.emitProgress({ phase: 'scanning', completed, total });

      await this.pool(domains, CONCURRENCY, async (domain) => {
        if (this.cancelled) return;
        const depth = deepSet.has(domain.slug) ? 'full' : 'shallow';
        this.emitProgress({ phase: 'scanning', domain: domain.slug, completed, total });
        await this.scanDomain(root, domain, model, depth, (message) =>
          this.emitProgress({ phase: 'scanning', domain: domain.slug, completed, total, message }),
        );
        if (!this.cancelled) this.writeDomainCard(domain, depth, undefined, false); // clear not-scanned
        completed += 1;
        this.emitProgress({ phase: 'scanning', domain: domain.slug, completed, total });
      });

      if (this.cancelled) {
        this.emitProgress({
          phase: 'cancelled',
          completed,
          total,
          message: 'Scan cancelled; scanned domains were kept.',
        });
      } else {
        this.emitProgress({ phase: 'done', completed, total });
        this.emitCalibration(this.calibrationRules());
      }
      return { started: true };
    } catch (err) {
      this.emitProgress({
        phase: 'error',
        completed: 0,
        total: 0,
        message: err instanceof Error ? err.message : String(err),
      });
      return { started: false };
    } finally {
      this.running = false;
      this.aborts.clear();
    }
  }

  /** Cancel mid-scan (decision 36): finished domains stay, the rest keep their not-scanned mark. */
  cancel(): void {
    this.cancelled = true;
    for (const abort of this.aborts) abort.abort();
  }

  /** Rescan one domain — destructive, so snapshot first (decision 43). */
  async rescanDomain(slug: string, model: string): Promise<{ started: boolean }> {
    return this.narrowPass(slug, async (root) => {
      this.backup();
      const map = (this.repoMap ??= await buildRepoMap(root));
      const cand = map.domains.find((d) => d.slug === slug);
      const domain: DomainProposal = {
        slug,
        title: cand?.title ?? slug,
        scope: cand?.scope ?? [`${slug}/**`],
      };
      await this.scanDomain(root, domain, model, 'full', (message) =>
        this.emitProgress({ phase: 'scanning', domain: slug, completed: 0, total: 1, message }),
      );
    });
  }

  /**
   * Deepen one node (decision 56): enrich the node the user clicked — its own body, deeper — rather
   * than splitting it into neighbours. Deepening is reading the spec as well as the code, so the
   * node's current body, its anchors, its parent card and its siblings all go into the prompt;
   * without them the agent writes a fresh description over what is already there.
   */
  async deepen(nodeId: string, model: string): Promise<{ started: boolean }> {
    // The whole body runs inside the pass, including the lookup: outside it, a throw (no project
    // open, an unreadable map) would reject the IPC call and vanish.
    return this.narrowPass('', async (root) => {
      const target = this.deepenTarget(nodeId);
      const domain = target.containers[0] ?? '';
      this.activeDomain = domain || null;
      this.emitProgress({ phase: 'scanning', domain, completed: 0, total: 1 }); // now we can name it
      this.backup();
      await this.runAgent(root, buildDeepenPrompt(target), model, 'full', (message) =>
        this.emitProgress({ phase: 'scanning', domain, completed: 0, total: 1, message }),
      );
      // Deterministic, like the phase checkboxes: the agent describes, the system records that this
      // node has been through a deep pass, so the card can show it honestly (decision 39's `depth`).
      if (target.kind === 'rule' && !this.cancelled) {
        new SpecStore(this.alethicDir(), this.clock).setDepth(nodeId, 'full');
      }
    });
  }

  /**
   * Migrate one branch from the pre-decision-56 form to features (Phase 6). Old maps are not left
   * to rot and they are not thrown away either: the agent folds the sentence-shaped nodes into
   * features that inherit their ids, and retires the rest with a reason. Afterwards the same
   * deterministic audit that raised the flag is re-run over the branch — if any node is still in
   * the old form, the pass reports that instead of claiming success, because a branch holding both
   * forms at once is exactly what this exists to prevent.
   */
  async migrate(nodeId: string, model: string): Promise<{ started: boolean }> {
    return this.narrowPass('', async (root) => {
      const target = this.migrationTarget(nodeId);
      this.activeDomain = target.containers[0] ?? null;
      const domain = this.activeDomain ?? '';
      this.emitProgress({ phase: 'scanning', domain, completed: 0, total: 1 });
      this.backup();
      await this.runAgent(root, buildMigrationPrompt(target), model, 'full', (message) =>
        this.emitProgress({ phase: 'scanning', domain, completed: 0, total: 1, message }),
      );
      if (this.cancelled) return;

      const remaining = this.legacyUnder(target.path);
      if (remaining.length > 0) {
        throw new Error(
          `${remaining.length} node${remaining.length === 1 ? ' is' : 's are'} still in the old form under “${target.title}” (${remaining
            .map((n) => n.title)
            .slice(0, 3)
            .join(', ')}${remaining.length > 3 ? ', …' : ''}) — run Migrate again on this branch.`,
        );
      }
    });
  }

  /** How many nodes under a branch (or the whole map) are still in the pre-feature form. */
  legacyUnder(containerPath?: string): { id: string; title: string; reason: string }[] {
    const { nodes } = loadAlethicDir(this.alethicDir());
    const dir = containerPath ? containerPath.replace(/\/[^/]+$/, '') : '';
    return auditForm(nodes.filter((n) => !dir || n.path.startsWith(`${dir}/`))).legacy.map(
      ({ id, title, reason }) => ({ id, title, reason }),
    );
  }

  /** The branch being migrated plus every node under it, for the migration prompt. */
  private migrationTarget(nodeId: string): MigrationTarget {
    const { nodes } = loadAlethicDir(this.alethicDir());
    const node = nodes.find((n) => n.meta?.id === nodeId);
    if (!node?.meta) throw new Error(`Node ${nodeId} is no longer in the map.`);
    if (node.meta.kind !== 'domain' && node.meta.kind !== 'sub')
      throw new Error(
        `“${node.meta.title}” is not a branch — migration regroups the nodes under a domain or a layer.`,
      );

    const index = buildIndex(toIndexEntries(nodes));
    // `domains/<a>/<b>/_sub.md` → the container path a child of this branch is written to.
    const containers = node.path.split('/').slice(1, -1);
    const children = (index.tree[nodeId] ?? [])
      .map((id) => nodes.find((n) => n.meta?.id === id))
      .filter(
        (n): n is (typeof nodes)[number] & { meta: NonNullable<(typeof nodes)[number]['meta']> } =>
          n?.meta?.kind === 'rule',
      )
      .map((child) => ({
        id: child.meta.id,
        title: child.meta.title,
        body: child.body,
        anchors: (
          (child.meta as { anchors?: { file: string; symbol?: string }[] }).anchors ?? []
        ).map((a) => ({ file: a.file, symbol: a.symbol })),
        legacy: legacyFormViolation(child.meta, child.body),
      }));
    if (children.length === 0)
      throw new Error(`“${node.meta.title}” has no features under it to migrate.`);
    return { title: node.meta.title, path: node.path, containers, children };
  }

  /** The clicked node plus its place in the spec, for the Deepen prompt. */
  private deepenTarget(nodeId: string): DeepenTarget {
    const { nodes } = loadAlethicDir(this.alethicDir());
    const node = nodes.find((n) => n.meta?.id === nodeId);
    if (!node?.meta) throw new Error(`Node ${nodeId} is no longer in the map.`);
    const index = buildIndex(toIndexEntries(nodes));
    const parentId = index.nodes[nodeId]?.parent;
    const parentNode = parentId ? nodes.find((n) => n.meta?.id === parentId) : undefined;
    const siblings = (parentId ? (index.tree[parentId] ?? []) : [])
      .filter((id) => id !== nodeId)
      .map((id) => index.nodes[id]?.title)
      .filter((t): t is string => Boolean(t));
    // `domains/<a>/<b>/…/<leaf>` — the containers are everything between `domains/` and the file
    // itself, at any depth (decision 56); a container node's own folder is the last segment.
    const parts = node.path.split('/').slice(1);
    const isLeaf = node.meta.kind === 'rule';
    const containers = parts.slice(0, -1);
    const slug = isLeaf ? parts.at(-1)!.replace(/\.md$/, '') : (containers.at(-1) ?? '');
    const anchors = (node.meta as { anchors?: { file: string; symbol?: string }[] }).anchors ?? [];
    return {
      id: nodeId,
      kind: node.meta.kind,
      title: node.meta.title,
      path: node.path,
      body: node.body,
      containers: isLeaf ? containers : containers.slice(0, -1),
      slug,
      anchors: anchors.map((a) => ({ file: a.file, symbol: a.symbol })),
      ...(parentNode?.meta
        ? {
            parent: {
              title: parentNode.meta.title,
              statement: firstLine(parentNode.body),
            },
          }
        : {}),
      ...(siblings.length ? { siblings } : {}),
    };
  }

  /**
   * One narrow scan pass (deepen / rescan) wrapped in the progress contract the full scan already
   * follows. These are fired from a node card, minutes long and with no other surface: a failure
   * that only rejects the IPC call is invisible in the window (Phase 2.1 found Deepen dying in
   * `backup()` with nothing shown at all).
   */
  private async narrowPass(
    domain: string,
    pass: (root: string) => Promise<void>,
  ): Promise<{ started: boolean }> {
    // One pass at a time, like `start()`. Without this every extra click spawned another scanner
    // over the same map (Phase 2.1: five snapshots in four minutes from an impatient button).
    if (this.running) {
      this.emitProgress({
        phase: 'error',
        domain,
        completed: 0,
        total: 1,
        message: 'A scan is already running — wait for it to finish.',
      });
      return { started: false };
    }
    this.running = true;
    // A cancelled full scan used to poison every later narrow pass: `cancelled` was only reset in
    // start(), so runAgent broke out of the stream on its first event and Deepen did nothing while
    // reporting success. Each pass starts from a clean flag, like start() does.
    this.cancelled = false;
    this.activeDomain = domain || null;
    try {
      const root = this.requireRoot();
      this.emitProgress({ phase: 'scanning', domain, completed: 0, total: 1 });
      await pass(root);
      this.emitProgress({ phase: 'done', domain, completed: 1, total: 1 });
      return { started: true };
    } catch (err) {
      this.emitProgress({
        phase: 'error',
        domain,
        completed: 0,
        total: 1,
        message: err instanceof Error ? err.message : String(err),
      });
      return { started: false };
    } finally {
      this.running = false;
      this.activeDomain = null;
    }
  }

  /** The three most central rules — the post-scan "check me" prompt (decision 40). */
  calibrationRules(): CalibrationRule[] {
    const { nodes } = loadAlethicDir(this.alethicDir());
    const index = buildIndex(toIndexEntries(nodes));
    const scored = Object.entries(index.nodes)
      .filter(([, n]) => n.kind === 'rule')
      .map(([id, n]) => {
        const affectedBy = index.affected_by[id]?.length ?? 0;
        const files = Object.entries(index.by_file).filter(([, ids]) => ids.includes(id));
        const shared = files.reduce((sum, [, ids]) => sum + ids.length, 0);
        return { id, title: n.title, path: n.path, score: affectedBy * 3 + shared };
      })
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return scored.slice(0, 3).map(({ id, title, path }) => ({ id, title, path }));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async scanDomain(
    root: string,
    domain: DomainProposal,
    model: string,
    depth: 'full' | 'shallow',
    onPulse?: (message: string) => void,
  ): Promise<void> {
    const map = this.repoMap;
    const digest = map ? repoMapDigest(map) : '';
    const prompt = `Scan the domain "${domain.slug}" (${domain.title}). Scope: ${domain.scope.join(', ')}.
Read the map first (alethic_read_map) so you continue it instead of starting a second one, then read the code in scope and record what it DOES as features with alethic_upsert_rule (domain: "${domain.slug}", choose sub slugs) — a named feature with a body, not one node per sentence. Coverage of the scope must be 100%: every file either informs a feature or is named as infrastructural in your summary.

${digest}`;
    await this.runAgent(root, prompt, model, depth, onPulse);
  }

  /**
   * A running scan and a dead one look identical from outside (`completed` only moves when a whole
   * domain finishes, and 3 run at once — PLAN.md known issues): a repository with ten domains sits
   * at "0 / 10" through minutes of real model work. This is the pulse *inside* a domain — the file
   * being read, or a running count of features written — built from tool-call events the agent
   * stream already carries, so the caller can show it is not stuck.
   */
  private async runAgent(
    root: string,
    prompt: string,
    model: string,
    depth: 'full' | 'shallow',
    onPulse?: (message: string) => void,
  ): Promise<void> {
    const abortController = new AbortController();
    this.aborts.add(abortController);
    let written = 0;
    const record = this.openLog(root, model);
    try {
      for await (const event of this.engine.run({
        role: 'scanner',
        model,
        prompt,
        cwd: root,
        depth,
        abortController,
      })) {
        if (event.type !== 'usage') record({ ts: this.clock(), kind: 'event', ...event });
        if (event.type === 'error' && /rate.?limit/i.test(event.message))
          throw new RateLimitError(event.message);
        if (event.type === 'tool' && onPulse) {
          if (event.name === 'Read') {
            const file = (event.input as { file_path?: string } | undefined)?.file_path;
            if (file) onPulse(`reading ${posix(relative(root, file)) || posix(file)}`);
          } else if (event.name.includes('upsert_rule')) {
            written += 1;
            onPulse(`${written} feature${written === 1 ? '' : 's'} written`);
          }
        }
        if (event.type === 'done' || event.type === 'error') break;
        if (this.cancelled) break;
      }
    } finally {
      this.aborts.delete(abortController);
    }
  }

  /**
   * A JSONL run log in the shape `AgentService` writes (decision 13), so a scan pass shows up
   * beside chat and phase runs in the same viewer instead of leaving nothing to diagnose a hang
   * with. Bookkeeping, not the work: a write failure — a missing directory, a full disk — must
   * never take a scan down with it, the same guarantee `AgentService` gives its own log. Written
   * synchronously (unlike `AgentService`'s stream) because a scan's events are comparatively rare —
   * nothing like a token-by-token chat stream — so there is no throughput reason to buffer, and
   * sync writes mean a crash right after `start` still leaves whatever was recorded on disk.
   */
  private openLog(cwd: string, model: string): (obj: unknown) => void {
    if (!this.logsDir) return () => {};
    const taskId = randomUUID();
    let logging = true;
    let path: string;
    try {
      mkdirSync(this.logsDir, { recursive: true });
      path = join(this.logsDir, `${taskId}.jsonl`);
    } catch {
      return () => {};
    }
    const record = (obj: unknown): void => {
      if (!logging) return;
      try {
        appendFileSync(path, `${JSON.stringify(obj)}\n`);
      } catch {
        logging = false;
      }
    };
    record({ ts: this.clock(), kind: 'start', taskId, role: 'scanner', model, cwd });
    return record;
  }

  /** Bounded-concurrency runner; drops to serial on a rate-limit signal (decision 9). */
  private async pool<T>(
    items: readonly T[],
    limit: number,
    work: (item: T) => Promise<void>,
  ): Promise<void> {
    let concurrency = Math.max(1, limit);
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < items.length && !this.cancelled) {
        const item = items[cursor++]!;
        try {
          await work(item);
        } catch (err) {
          if (err instanceof RateLimitError) concurrency = 1; // auto-reduce
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()));
  }

  private ensureAlethic(root: string): void {
    const dir = join(root, '.alethic');
    if (existsSync(join(dir, 'alethic.md'))) return;
    mkdirSync(join(dir, 'domains'), { recursive: true });
    writeFileSync(
      join(dir, 'config.yaml'),
      'format: 1\nlanguage: en\nstack: []\nscan:\n  include: ["**"]\n  exclude: []\nlimits:\n  max_rules_per_sub: 40\n',
      'utf8',
    );
    const ts = this.clock();
    writeFileSync(
      join(dir, 'alethic.md'),
      serialize({
        meta: {
          id: genId('root'),
          kind: 'root',
          title: basename(root),
          created: ts,
          updated: ts,
          updated_by: 'scanner',
        },
        body: `The living map of ${basename(root)}.`,
      }),
      'utf8',
    );
  }

  /** Write (or refresh) a domain card, preserving its id. */
  private writeDomainCard(
    domain: DomainProposal,
    depth: 'full' | 'shallow',
    order?: number,
    notScanned = false,
  ): void {
    new SpecStore(this.alethicDir(), this.clock).ensureSection('code'); // the "Code" branch (decision 55)
    const dir = join(this.alethicDir(), 'domains', slugify(domain.slug));
    const file = join(dir, '_domain.md');
    const { nodes } = existsSync(this.alethicDir())
      ? loadAlethicDir(this.alethicDir())
      : { nodes: [] };
    const existing = nodes.find((n) => n.path === `domains/${slugify(domain.slug)}/_domain.md`);
    const ts = this.clock();
    mkdirSync(dir, { recursive: true });
    const body = [
      domain.description ?? `The ${domain.title.toLowerCase()} domain.`,
      notScanned ? `\n${NOT_SCANNED}` : '',
    ]
      .join('')
      .trim();
    writeFileSync(
      file,
      serialize({
        meta: {
          id: existing?.meta?.id ?? genId('domain'),
          kind: 'domain',
          title: domain.title,
          scope: domain.scope,
          depth,
          ...(order !== undefined ? { order } : {}),
          created: existing?.meta?.created ?? ts,
          updated: ts,
          updated_by: 'scanner',
        },
        body,
      }),
      'utf8',
    );
  }

  /** Snapshot .alethic/ before a destructive operation; keep the last 5 (decision 43). */
  backup(): string | null {
    const dir = this.alethicDir();
    if (!existsSync(dir)) return null;
    const backupsRoot = join(dir, '.backup');
    mkdirSync(backupsRoot, { recursive: true });
    const stamp = this.clock().replace(/[:.]/g, '-');
    const dest = join(backupsRoot, stamp);
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(dir)) {
      if (entry === '.backup') continue;
      cpSync(join(dir, entry), join(dest, entry), { recursive: true });
    }
    // Prune only whole-map snapshots — the ones this method makes, recognisable by the root node
    // they contain. `.backup/` is shared with `alethic_retire_rule`, which drops a single retired
    // node per timestamped folder, and counting those towards the five cost python-app its
    // pre-migration snapshots on the very first live migration (Phase 6): one pass that retired
    // four nodes evicted the snapshot taken to make that pass reversible. A snapshot must outlive
    // the operation it exists to undo.
    const kept = readdirSync(backupsRoot)
      .filter((entry) => existsSync(join(backupsRoot, entry, 'alethic.md')))
      .sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) {
      // Pruning is housekeeping: it must never fail the operation the user actually asked for.
      // On Windows a recursive delete races anything holding a handle inside the tree (watcher,
      // indexer, antivirus) and throws ENOTEMPTY — which is exactly how Deepen died in Phase 2.1,
      // before its agent ever started. Retry, then leave the stale snapshot behind and carry on.
      try {
        rmSync(join(backupsRoot, old), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      } catch {
        /* a snapshot we could not delete costs disk, not correctness */
      }
    }
    return dest;
  }
}

class RateLimitError extends Error {}

/** The first non-empty line of a body — a container card's own assertion, for the Deepen context. */
const firstLine = (body: string): string => (body.split('\n').find((l) => l.trim()) ?? '').trim();

/** Pull the first JSON array out of the model's reply. */
function parseDomainJson(text: string): DomainProposal[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as DomainProposal[];
    return raw
      .filter((d) => d && typeof d.slug === 'string' && Array.isArray(d.scope))
      .map((d) => ({
        slug: slugify(d.slug),
        title: decodeHtmlEntities(d.title || d.slug),
        ...(d.description ? { description: decodeHtmlEntities(d.description) } : {}),
        scope: d.scope,
      }));
  } catch {
    return null;
  }
}
