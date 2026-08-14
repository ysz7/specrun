// SpecStore — the validated write path into a project's .alethic/. Every alethic_* MCP tool goes
// through here; nothing hand-writes markdown. Schema and status-transition validation come from
// @alethic/format, so a bad write is rejected with a structured error the agent must fix.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  anchorFor,
  assertTransition,
  buildIndex,
  decodeHtmlEntities,
  fileHash,
  genId,
  IllegalTransitionError,
  loadAlethicDir,
  markPhaseDone,
  mergeDuplicateSections,
  parse,
  PLACEHOLDER_CONTAINER_BODY,
  schemaForKind,
  serialize,
  setPhaseNote,
  slugify,
  titleNormViolation,
  toIndexEntries,
  type Anchor,
  type NodeMeta,
  type PlanStepMeta,
  type RuleMeta,
  type RuleStatus,
  type StepStatus,
  type Writer,
} from '@alethic/format';

// Anchor paths cross a trust boundary here — the agent (an LLM) supplies `anchor.file` as a raw
// string, and `\`-separated paths have reached this codebase before. `path.join` on POSIX treats
// `\` as a literal filename character rather than a separator, so an unnormalized path silently
// fails to resolve instead of erroring.
const posix = (p: string): string => p.replace(/\\/g, '/');

/** A structured tool error — returned to the agent so it can correct and retry, not bypass. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

// `| undefined` on optionals so the zod-inferred tool inputs (which carry explicit undefined)
// assign cleanly under exactOptionalPropertyTypes.
/** What the agent may say about an anchor: the tool derives the rest from the code (format-spec §5). */
export interface AnchorInput {
  file: string;
  symbol?: string | undefined;
  span?: [number, number] | undefined;
  hash?: string | undefined;
  dochash?: string | undefined;
}

export interface UpsertRuleInput {
  id?: string | undefined;
  /**
   * The containers this feature hangs under, outermost first: `["cli","commands","add"]`. Depth is
   * not limited (decision 56) — a feature that fills up becomes a layer and its sub-features live
   * one level deeper. `domain` + `sub` are the two-segment form of the same thing, kept so pre-depth
   * callers and prompts keep working.
   */
  path?: readonly string[] | undefined;
  domain?: string | undefined; // domain slug (legacy pair)
  sub?: string | undefined; // sub slug (legacy pair)
  title: string;
  body: string; // statement + ## sections
  status?: RuleStatus | undefined;
  provenance?: ('agent' | 'human' | 'mixed') | undefined;
  anchors?: AnchorInput[] | undefined;
  affects?: string[] | undefined;
  tests?: string[] | undefined;
}

export interface UpsertPlanInput {
  id?: string | undefined;
  slug: string; // plan folder slug
  title: string;
  goal: string; // one-phrase intent (SDD: intent first)
  domains?: string[] | undefined; // affected domain ids
  body?: string | undefined;
}

export interface UpsertNoteInput {
  id?: string | undefined;
  parent?: string | undefined; // parent node id (a note or the root); omitted → top-level
  title: string;
  body: string; // markdown content of this section/leaf
}

export interface MapNode {
  id: string;
  kind: NodeMeta['kind'];
  title: string;
  status?: string;
  path: string;
  parent?: string;
}

const nowIso = (): string => new Date().toISOString();

/** A readable title from a slug ("cli-runtime" → "Cli runtime"), padded to the schema's 3-char floor. */
function titleize(slug: string, kindWord: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return title.length >= 3 ? title : `${title} ${kindWord}`;
}

/** A `## Drift log` section with real content (mirrors the validator). */
function hasDriftLogEntry(body: string): boolean {
  const lines = body.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+Drift log\s*$/.test(l));
  if (idx < 0) return false;
  const section: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    section.push(lines[i]!);
  }
  return (
    section
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim().length > 0
  );
}

export class SpecStore {
  constructor(
    private readonly alethicDir: string,
    private readonly clock: () => string = nowIso,
    private readonly mkId: (kind: NodeMeta['kind']) => string = genId,
  ) {}

  /** Read-only map summary (alethic_read_map). */
  readMap(scope?: string): { root: string; nodes: MapNode[]; counts: Record<string, number> } {
    const { nodes } = loadAlethicDir(this.alethicDir);
    const index = buildIndex(toIndexEntries(nodes));
    const list: MapNode[] = Object.entries(index.nodes)
      .filter(([, n]) => !scope || n.path.startsWith(scope))
      .map(([id, n]) => ({
        id,
        kind: n.kind,
        title: n.title,
        ...(n.status ? { status: n.status } : {}),
        path: n.path,
        ...(n.parent ? { parent: n.parent } : {}),
      }));
    const counts: Record<string, number> = {};
    for (const n of list) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    return { root: this.alethicDir, nodes: list, counts };
  }

  /** Find an existing node's path (relative + absolute) + parsed meta by id (scans the tree). */
  private findById(
    id: string,
  ): { rel: string; path: string; meta: NodeMeta; body: string } | undefined {
    const { nodes } = loadAlethicDir(this.alethicDir);
    const hit = nodes.find((n) => n.meta?.id === id);
    if (!hit || !hit.meta) return undefined;
    return { rel: hit.path, path: join(this.alethicDir, hit.path), meta: hit.meta, body: hit.body };
  }

  private write(absPath: string, meta: NodeMeta, body: string): void {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, serialize({ meta, body }), 'utf8');
  }

  /**
   * The two top branches of the pyramid (dev-planning v2, decision 55): `plans/_section.md` is
   * "Plan" (the living roadmap — what we intend to build) and `domains/_section.md` is "Code" (what
   * the code actually does). Created lazily on the first write into either tree, so a plan-mode
   * project (notes only) never grows them, and an existing project gets them on its next write.
   */
  ensureSection(branch: 'plan' | 'code'): { id: string; path: string; created: boolean } {
    const dir = branch === 'plan' ? 'plans' : 'domains';
    const rel = join(dir, '_section.md');
    const abs = join(this.alethicDir, rel);
    if (existsSync(abs)) {
      const meta = parse(readFileSync(abs, 'utf8')).meta;
      if (meta?.kind === 'section') return { id: meta.id, path: rel, created: false };
    }
    const ts = this.clock();
    const meta = {
      id: this.mkId('section'),
      kind: 'section' as const,
      title: branch === 'plan' ? 'Plan' : 'Code',
      branch,
      order: branch === 'plan' ? 1 : 2,
      created: ts,
      updated: ts,
      updated_by: 'system' as Writer,
    };
    const body =
      branch === 'plan'
        ? 'What we intend to build — the living roadmap, phase by phase.'
        : 'What the code actually does — domains and the rules scanned out of them.';
    this.write(abs, meta as NodeMeta, body);
    return { id: meta.id, path: rel, created: true };
  }

  /**
   * The container path a node hangs from (decision 56 lifted the two-level limit): the first segment
   * is the domain, every deeper one a sub. `domain` + `sub` are still accepted — they are simply the
   * two-segment path — so maps and callers written before the depth existed keep working.
   */
  private containerPath(input: {
    path?: readonly string[] | undefined;
    domain?: string | undefined;
    sub?: string | undefined;
  }): { slug: string; name: string }[] {
    const names = (input.path?.length ? input.path : [input.domain ?? '', input.sub ?? ''])
      .filter((name): name is string => Boolean(name && name.trim()))
      .map(decodeHtmlEntities);
    if (names.length === 0)
      throw new ToolError(
        'schema',
        'A feature needs a container path — at least a domain, e.g. path: ["cli","commands"].',
      );
    return names.map((name) => ({ slug: slugify(name), name }));
  }

  /**
   * Materialize the containers a node hangs from, at any depth. Parent/child comes from the folder
   * layout (format-spec §6): a rule written into a domain/sub whose card is missing has no parent at
   * all and renders nowhere — the map would silently swallow it, which is exactly the lie by
   * omission constitution rule 7 forbids. Cards are only ever created, never overwritten: a real
   * scan, a Deepen pass or a human writes better ones, and those stand.
   *
   * A segment that is currently a FEATURE file (`add.md`) is promoted into the container it has to
   * become (`add/_sub.md`, same id) — decision 56's "the pyramid grows inward": when a feature turns
   * out to hold several independent sub-features, it stops being a leaf without losing its identity,
   * its history or the `affects` edges pointing at it.
   */
  private ensureContainers(
    segments: readonly { slug: string; name: string }[],
    anchors: readonly Anchor[],
  ): void {
    const ts = this.clock();
    const files = [...new Set(anchors.map((a) => posix(a.file)))];
    for (const [depth, segment] of segments.entries()) {
      const dir = join(
        this.alethicDir,
        'domains',
        ...segments.slice(0, depth + 1).map((s) => s.slug),
      );
      const card = join(dir, depth === 0 ? '_domain.md' : '_sub.md');
      if (existsSync(card)) continue;
      if (depth > 0 && this.promoteLeaf(dir)) continue; // a feature became this layer's roof
      this.write(
        card,
        depth === 0
          ? {
              id: this.mkId('domain'),
              kind: 'domain',
              title: titleize(segment.name, 'domain'),
              scope: files.length > 0 ? files : ['**'],
              created: ts,
              updated: ts,
              updated_by: 'system',
            }
          : {
              id: this.mkId('sub'),
              kind: 'sub',
              title: titleize(segment.name, 'group'),
              created: ts,
              updated: ts,
              updated_by: 'system',
            },
        depth === 0 ? PLACEHOLDER_CONTAINER_BODY.domain : PLACEHOLDER_CONTAINER_BODY.sub,
      );
    }
  }

  /**
   * A feature that is gaining children: `…/add.md` becomes `…/add/_sub.md`, keeping its id, title
   * and body (decision 56 — the roof of a layer must still assert something, and the feature's own
   * statement is the truest summary available). Its anchors become the container's `scope`: the
   * children carry the symbol-level anchors from here on. Returns false when there is no such leaf.
   */
  private promoteLeaf(dir: string): boolean {
    const leaf = `${dir}.md`;
    if (!existsSync(leaf)) return false;
    const parsed = parse(readFileSync(leaf, 'utf8'));
    if (!parsed.meta || parsed.meta.kind !== 'rule') return false;
    const rule = parsed.meta as RuleMeta;
    const scope = [...new Set(rule.anchors.map((a) => posix(a.file)))];
    this.write(
      join(dir, '_sub.md'),
      {
        id: rule.id,
        kind: 'sub',
        ...(scope.length > 0 ? { scope } : {}),
        title: rule.title,
        ...(rule.order !== undefined ? { order: rule.order } : {}),
        created: rule.created,
        updated: this.clock(),
        updated_by: 'system',
      } as NodeMeta,
      parsed.body,
    );
    rmSync(leaf);
    return true;
  }

  /**
   * Derive every anchor from the code on disk with our own extractor (format-spec §5). The agent
   * cannot compute a structural hash — left to itself it hashes a line range with whatever library
   * it can install, and the drift checker then reads every such rule as drifted the moment it runs.
   * The tool owns the hash; the agent only says *what* it anchors to. Degradation follows the tiers
   * of decision 51: symbol found → symbol anchor; file readable but symbol not found → file anchor
   * (the index flags it `file-anchored`); file unreadable → keep what we were handed if it is
   * usable, else drop it rather than write a hash that means nothing.
   */
  private async withRealAnchors(anchors: readonly AnchorInput[]): Promise<Anchor[]> {
    const repoRoot = dirname(this.alethicDir);
    const out: Anchor[] = [];
    for (const anchor of anchors) {
      const file = posix(anchor.file);
      const source = ((): string | null => {
        try {
          return readFileSync(join(repoRoot, file), 'utf8');
        } catch {
          return null;
        }
      })();
      if (source !== null) {
        const fresh = anchor.symbol ? await anchorFor(file, source, anchor.symbol) : undefined;
        out.push(fresh ?? { file, hash: fileHash(source) });
      } else if (anchor.hash) {
        out.push({ ...anchor, file, hash: anchor.hash });
      }
    }
    return out;
  }

  /** alethic_upsert_rule — validated create/update of a rule. */
  async upsertRule(
    input: UpsertRuleInput,
    by: Writer = 'scanner',
  ): Promise<{ id: string; path: string; created: boolean }> {
    const id = input.id ?? this.mkId('rule');
    // A model that means "&" sometimes hands back "&amp;" — decode before the title is validated,
    // slugified or stored, so neither the card nor the folder name ever carries the escape.
    const title = decodeHtmlEntities(input.title);
    // The unit of the map is a feature, and its title is the feature's NAME (decision 56). Asking
    // for that in the prompt is not enough — the old granularity produced a column of sentences,
    // and prompts drift back to it. The tool holds the norm instead: a structured error the agent
    // must fix and retry, exactly like an anchor on a file that isn't there.
    const violation = titleNormViolation(title);
    if (violation) {
      throw new ToolError(
        'title-not-a-name',
        `A node's title is the feature's name, not an assertion: ${violation}. Re-title the node (e.g. "Adding a task") and write the statement as the first line of the body.`,
      );
    }
    this.ensureSection('code');
    const slug = slugify(title);
    // The folder layout IS the hierarchy (format-spec §6), so a container's folder is always the
    // slug of its title — the validator checks exactly that. The agent names domains in prose
    // ("Anchoring", "Plan phases"), which the Phase 2.1 run put on disk verbatim: warnings from
    // the validator, and a rescan that capitalises differently would fork a second folder for the
    // same domain. Slugify here; the card keeps the readable name as its title.
    const segments = this.containerPath(input);
    const rel = ['domains', ...segments.map((s) => s.slug), `${slug}.md`].join('/');

    const existing = input.id ? this.findById(input.id) : undefined;
    if (existing && existing.meta.kind !== 'rule') {
      // That id is a layer now, not a leaf (it grew children and became their roof, decision 56).
      // Writing a rule over it would replace the container its children hang from — they would all
      // lose their parent at once. The roof is written with its own tool.
      throw new ToolError(
        'is-a-container',
        `${id} is no longer a feature — it became the roof of a layer (${existing.rel}). Write its children with alethic_upsert_rule, or its own card with alethic_upsert_container.`,
      );
    }
    if (existing && existing.meta.kind === 'rule') {
      const prov = (existing.meta as RuleMeta).provenance;
      if ((existing.meta as RuleMeta).locked || prov === 'human') {
        throw new ToolError(
          'locked',
          `Rule ${id} is locked/human — use alethic_propose_edit, do not overwrite.`,
        );
      }
    }

    const created = this.clock();
    // Deepen rewrites a node's body pass after pass (decision 56). A model that appends its new
    // findings leaves a second "## Invariants" under the first, and the node becomes two documents
    // stapled together — so repeated sections are folded back into the first occurrence here,
    // rather than asked for in the prompt.
    const body = mergeDuplicateSections(input.body);
    const anchors = await this.withRealAnchors(input.anchors ?? []);
    // Truth over completeness (constitution): an anchor is what ties a rule to real code. If the
    // agent handed us anchors and not one of them resolved, the files it is describing are not in
    // this project — writing the rule anyway would put a confident lie on the map. Dog-fooding hit
    // exactly this: the run wrote its code outside the project root, and four rules landed
    // describing code that was not there. Hand the agent a structured error so it can fix and retry.
    if ((input.anchors?.length ?? 0) > 0 && anchors.length === 0) {
      const missing = [...new Set(input.anchors!.map((a) => a.file))].join(', ');
      throw new ToolError(
        'not-found',
        `None of the anchored files exist in this project: ${missing}. Anchor the rule to code that is really here (paths are relative to the project root), or don't write the rule.`,
      );
    }
    // An update that mentions no anchors is an omission, not a claim that the code is gone. The
    // first live Deepen run showed exactly this: the pass came back with a much richer body and an
    // empty `anchors`, and the node — anchored a minute earlier — lost its tie to the code and its
    // place in `by_file`, i.e. drift stopped seeing it. Enriching a node never costs it anchors;
    // "this feature no longer has code" is said with alethic_retire_rule, not by staying silent.
    const kept =
      anchors.length === 0 && existing?.meta.kind === 'rule'
        ? (existing.meta as RuleMeta).anchors
        : anchors;
    this.ensureContainers(segments, kept);
    const meta = {
      id,
      kind: 'rule' as const,
      title,
      status: input.status ?? ('ok' as RuleStatus),
      provenance: input.provenance ?? ('agent' as const),
      locked: false,
      anchors: kept,
      affects: input.affects ?? [],
      tests: input.tests ?? [],
      // Depth is the system's record of how closely this node has been read (decision 39/56), not
      // something the agent asserts — a re-upsert of an already-deepened node keeps its mark.
      ...(existing?.meta.kind === 'rule' && (existing.meta as RuleMeta).depth
        ? { depth: (existing.meta as RuleMeta).depth }
        : {}),
      created: existing?.meta.created ?? created,
      updated: created,
      updated_by: by,
    };

    const parsed = schemaForKind('rule').safeParse(meta);
    if (!parsed.success) {
      throw new ToolError(
        'schema',
        `Rule failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    if (meta.status === 'drift' && !hasDriftLogEntry(body)) {
      throw new ToolError(
        'drift-no-log',
        'status "drift" requires a "## Drift log" entry — call alethic_log_drift.',
      );
    }
    // A rename follows the title. The folder layout IS the hierarchy (format-spec §6) and a leaf's
    // filename is the slug of its title, so writing an updated node back to its old filename leaves
    // the two permanently out of step — the validator's `slug-mismatch`, on every node a migration
    // touches (Phase 6: "Add persists the full task list before printing." becoming "Adding a task"
    // would have stayed in `add-persists-the-full-task-list-before-printing.md`). The node keeps its
    // id and its place; only its file is renamed, and the old one is removed after the new one lands.
    // `existing.rel` is posix (the loader's), so the new name is built posix too — comparing a
    // `join()`ed path against it on Windows would read every write as a rename and delete the file
    // it had just written.
    const dest = existing ? existing.rel.replace(/[^/]+$/, `${slug}.md`) : rel;
    this.write(join(this.alethicDir, dest), parsed.data as NodeMeta, body);
    if (existing && dest !== existing.rel) rmSync(existing.path);
    return { id, path: dest, created: !existing };
  }

  /**
   * alethic_move_rule — regroup a feature without losing it (decision 56). Moving is not
   * delete-and-rewrite: the `id` is what history, `affects` edges and the drift log hang from, so a
   * regrouping that mints a new id silently severs every one of them. The node keeps its id, its
   * body and its anchors and simply lands under a different container path; the containers on the
   * way are materialized (a feature standing where a layer must be is promoted into that layer).
   */
  moveRule(
    id: string,
    path: readonly string[],
    by: Writer = 'scanner',
  ): { id: string; from: string; to: string } {
    const node = this.findById(id);
    if (!node || node.meta.kind !== 'rule')
      throw new ToolError('not-found', `No feature with id ${id} to move.`);
    const segments = this.containerPath({ path });
    const rel = join('domains', ...segments.map((s) => s.slug), `${slugify(node.meta.title)}.md`);
    if (rel === node.rel) return { id, from: node.rel, to: node.rel };

    this.ensureSection('code');
    this.ensureContainers(segments, (node.meta as RuleMeta).anchors);
    const meta = { ...node.meta, updated: this.clock(), updated_by: by } as NodeMeta;
    this.write(join(this.alethicDir, rel), meta, node.body);
    // Written first, removed second: a crash between the two leaves a duplicate id the validator
    // reports, never a node that exists in no file at all.
    rmSync(node.path);
    return { id, from: node.rel, to: rel };
  }

  /**
   * alethic_upsert_container — the roof of a layer says what its children have in common
   * (decision 56: a group of 3–7 siblings has a summarizing parent, not a folder name). Auto-created
   * cards carry a placeholder; this is how an agent replaces it with a real assertion. Only
   * containers of the Code branch, and never over a human body (rule 6).
   */
  upsertContainer(
    input: {
      path: readonly string[];
      title: string;
      body: string;
      scope?: readonly string[] | undefined;
    },
    by: Writer = 'scanner',
  ): { id: string; path: string; created: boolean } {
    const title = decodeHtmlEntities(input.title);
    const violation = titleNormViolation(title);
    if (violation)
      throw new ToolError(
        'title-not-a-name',
        `A container's title is a name, not an assertion: ${violation}. The assertion is the first line of its body.`,
      );
    const segments = this.containerPath({ path: input.path });
    this.ensureSection('code');
    this.ensureContainers(segments, []);
    const dir = join('domains', ...segments.map((s) => s.slug));
    const rel = join(dir, segments.length === 1 ? '_domain.md' : '_sub.md');
    const abs = join(this.alethicDir, rel);
    const existing = parse(readFileSync(abs, 'utf8')).meta;
    if (!existing) throw new ToolError('unparsable', `Cannot read the container at ${rel}.`);
    if (existing.updated_by === 'human')
      throw new ToolError(
        'locked',
        `${rel} was written by a human — use alethic_propose_edit, do not overwrite.`,
      );
    const scope = input.scope?.length ? [...input.scope] : (existing as { scope?: string[] }).scope;
    const meta = {
      ...existing,
      title,
      ...(scope ? { scope } : {}),
      updated: this.clock(),
      updated_by: by,
    } as NodeMeta;
    const parsed = schemaForKind(meta.kind).safeParse(meta);
    if (!parsed.success)
      throw new ToolError(
        'schema',
        `Container failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    this.write(abs, parsed.data as NodeMeta, mergeDuplicateSections(input.body));
    return { id: existing.id, path: rel, created: false };
  }

  /**
   * Record how closely a node has been read (decision 39's `depth`, reused by decision 56's Deepen).
   * Deterministic and system-written — the pipeline sets it when a pass actually ran, the way phase
   * checkboxes are ticked by the system rather than claimed by the agent.
   */
  setDepth(id: string, depth: 'full' | 'shallow'): { id: string } {
    const node = this.findById(id);
    if (!node) throw new ToolError('not-found', `No node with id ${id}.`);
    if (node.meta.kind !== 'rule' && node.meta.kind !== 'domain' && node.meta.kind !== 'sub')
      throw new ToolError('not-found', `Node ${id} (${node.meta.kind}) carries no depth.`);
    const meta = { ...node.meta, depth, updated: this.clock() } as NodeMeta;
    this.write(node.path, meta, node.body);
    return { id };
  }

  /** alethic_set_status — the only status-transition entry point (format-spec §1.2). */
  setStatus(
    id: string,
    to: RuleStatus | StepStatus,
    by: Writer,
  ): { id: string; from: string; to: string } {
    const node = this.findById(id);
    if (!node || (node.meta.kind !== 'rule' && node.meta.kind !== 'plan-step')) {
      throw new ToolError('not-found', `No rule or plan-step with id ${id}.`);
    }
    const from = (node.meta as RuleMeta | PlanStepMeta).status;
    try {
      assertTransition(from, to, by);
    } catch (err) {
      if (err instanceof IllegalTransitionError)
        throw new ToolError('illegal-transition', err.message);
      throw err;
    }
    if (to === 'drift' && !hasDriftLogEntry(node.body)) {
      throw new ToolError(
        'drift-no-log',
        'Transition to "drift" requires a "## Drift log" entry — call alethic_log_drift first.',
      );
    }
    const meta = { ...node.meta, status: to, updated: this.clock(), updated_by: by } as NodeMeta;
    this.write(node.path, meta, node.body);
    return { id, from, to };
  }

  /** alethic_log_drift — append a dated entry under ## Drift log (required before status: drift). */
  logDrift(id: string, entry: string): { id: string } {
    const node = this.findById(id);
    if (!node) throw new ToolError('not-found', `No node with id ${id}.`);
    const date = this.clock().slice(0, 10);
    const line = `- ${date} sync: ${entry.trim()}`;
    let body = node.body;
    if (/^##\s+Drift log\s*$/m.test(body)) {
      body = body.replace(/(^##\s+Drift log\s*$)/m, `$1\n${line}`);
    } else {
      body = `${body.trimEnd()}\n\n## Drift log\n${line}\n`;
    }
    this.write(node.path, { ...node.meta, updated: this.clock() } as NodeMeta, body);
    return { id };
  }

  /** alethic_propose_edit — for locked/human/mixed bodies: store a proposal, never overwrite (decision 14). */
  proposeEdit(id: string, body: string): { id: string; proposalPath: string } {
    const node = this.findById(id);
    if (!node) throw new ToolError('not-found', `No node with id ${id}.`);
    const rel = join('.proposals', `${id}.md`);
    const abs = join(this.alethicDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    return { id, proposalPath: rel };
  }

  /** alethic_retire_rule — move to .backup/ rather than delete (§6). */
  retireRule(id: string, reason: string): { id: string; backupPath: string } {
    const node = this.findById(id);
    if (!node || node.meta.kind !== 'rule')
      throw new ToolError('not-found', `No rule with id ${id}.`);
    const stamp = this.clock().replace(/[:.]/g, '-');
    const rel = join('.backup', stamp, `${id}.md`);
    const abs = join(this.alethicDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const withReason = `<!-- retired: ${reason} -->\n${readFileSync(node.path, 'utf8')}`;
    writeFileSync(abs, withReason, 'utf8');
    rmSync(node.path);
    return { id, backupPath: rel };
  }

  /** alethic_upsert_plan — validated create/update of a plan container (`_plan.md`). */
  upsertPlan(
    input: UpsertPlanInput,
    by: Writer = 'executor',
  ): { id: string; path: string; created: boolean } {
    const id = input.id ?? this.mkId('plan');
    this.ensureSection('plan');
    const slug = slugify(input.slug);
    const rel = join('plans', slug, '_plan.md');
    const abs = join(this.alethicDir, rel);
    const existing = input.id ? this.findById(input.id) : undefined;
    const created = this.clock();
    const meta = {
      id,
      kind: 'plan' as const,
      title: decodeHtmlEntities(input.title),
      goal: input.goal,
      domains: input.domains ?? [],
      created: existing?.meta.created ?? created,
      updated: created,
      updated_by: by,
    };
    const parsed = schemaForKind('plan').safeParse(meta);
    if (!parsed.success) {
      throw new ToolError(
        'schema',
        `Plan failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    this.write(existing?.path ?? abs, parsed.data as NodeMeta, input.body ?? input.goal);
    return { id, path: existing?.rel ?? rel, created: !existing };
  }

  /** alethic_upsert_note — plan-mode content authoring (decision 54). Creates/updates a `note`
   * container (`_note.md`) so it can nest; parent is another note or the root. Human/locked bodies
   * are inviolable (rule 6) — the agent must propose_edit instead. */
  upsertNote(
    input: UpsertNoteInput,
    by: Writer = 'executor',
  ): { id: string; path: string; created: boolean } {
    const id = input.id ?? this.mkId('note');
    const title = decodeHtmlEntities(input.title);
    const slug = slugify(title);
    let baseDir = 'notes';
    if (input.parent) {
      const parent = this.findById(input.parent);
      if (parent && parent.meta.kind === 'note') baseDir = dirname(parent.rel);
    }
    const rel = join(baseDir, slug, '_note.md');
    const abs = join(this.alethicDir, rel);

    const existing = input.id ? this.findById(input.id) : undefined;
    if (existing && existing.meta.kind === 'note') {
      if (existing.meta.locked || existing.meta.provenance === 'human') {
        throw new ToolError(
          'locked',
          `Note ${id} is human/locked — use alethic_propose_edit, do not overwrite.`,
        );
      }
    }

    const created = this.clock();
    const meta = {
      id,
      kind: 'note' as const,
      title,
      provenance: 'agent' as const,
      locked: false,
      created: existing?.meta.created ?? created,
      updated: created,
      updated_by: by,
    };
    const parsed = schemaForKind('note').safeParse(meta);
    if (!parsed.success) {
      throw new ToolError(
        'schema',
        `Note failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    this.write(existing?.path ?? abs, parsed.data as NodeMeta, input.body);
    return { id, path: existing?.rel ?? rel, created: !existing };
  }

  /** Mark every checklist item of a plan phase done (dev-planning v2, decision 55). Deterministic —
   * called by the executor pipeline after a phase's run succeeds, not by the agent. */
  markPlanPhaseDone(id: string, phaseIndex: number): { id: string } {
    const node = this.findById(id);
    if (!node || node.meta.kind !== 'plan')
      throw new ToolError('not-found', `No plan with id ${id}.`);
    const body = markPhaseDone(node.body, phaseIndex);
    this.write(node.path, { ...node.meta, updated: this.clock() } as NodeMeta, body);
    return { id };
  }

  /** Record what a finished phase produced inside the plan document (decision 55). Deterministic —
   * written by the executor pipeline from what it observed, not by the agent. */
  setPlanPhaseNote(id: string, phaseIndex: number, note: string): { id: string } {
    const node = this.findById(id);
    if (!node || node.meta.kind !== 'plan')
      throw new ToolError('not-found', `No plan with id ${id}.`);
    const body = setPhaseNote(node.body, phaseIndex, note);
    this.write(node.path, { ...node.meta, updated: this.clock() } as NodeMeta, body);
    return { id };
  }

  /** alethic_set_thesis — set the project's apex thesis in alethic.md (root body), for greenfield. */
  setThesis(text: string, by: Writer = 'executor'): { id: string } {
    const abs = join(this.alethicDir, 'alethic.md');
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      throw new ToolError('not-found', 'No alethic.md root to set the thesis on.');
    }
    const parsed = parse(raw);
    if (!parsed.meta || parsed.meta.kind !== 'root')
      throw new ToolError('not-root', 'alethic.md is not a valid root node.');
    const meta = { ...parsed.meta, updated: this.clock(), updated_by: by } as NodeMeta;
    this.write(abs, meta, text.trim());
    return { id: parsed.meta.id };
  }

  /**
   * A human edit of a node's title + body (decision 16). This is the one write path that is NOT an
   * agent MCP tool — the human is a first-class writer. It sets `updated_by: human` and, for rules,
   * `provenance: human` so the agent will never again overwrite the body (constitution rule 6).
   * Statuses are untouched (rule 4). Detects an on-disk conflict (decision 17): if the file's
   * `updated` no longer matches `expectedUpdated`, it refuses unless `force` is set, so the caller
   * can offer a reload/overwrite dialog.
   */
  saveHuman(
    rel: string,
    edit: { title?: string; body: string },
    expectedUpdated?: string,
    force = false,
  ): { ok: boolean; conflict?: true; updated: string; title: string; body: string } {
    const abs = join(this.alethicDir, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch {
      throw new ToolError('not-found', `No node at ${rel}.`);
    }
    const parsed = parse(raw);
    if (!parsed.meta) throw new ToolError('unparsable', `Cannot edit ${rel}: invalid frontmatter.`);

    if (!force && expectedUpdated !== undefined && parsed.meta.updated !== expectedUpdated) {
      return {
        ok: false,
        conflict: true,
        updated: parsed.meta.updated,
        title: parsed.meta.title,
        body: parsed.body,
      };
    }

    const now = this.clock();
    const meta = {
      ...parsed.meta,
      ...(edit.title ? { title: edit.title } : {}),
      ...(parsed.meta.kind === 'rule' ? { provenance: 'human' as const } : {}),
      updated: now,
      updated_by: 'human' as Writer,
    } as NodeMeta;

    const validated = schemaForKind(meta.kind).safeParse(meta);
    if (!validated.success) {
      throw new ToolError(
        'schema',
        `Edit failed schema: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    this.write(abs, validated.data as NodeMeta, edit.body);
    return { ok: true, updated: now, title: meta.title, body: edit.body };
  }
}
