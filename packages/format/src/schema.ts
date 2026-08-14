// The .alethic/ frontmatter schemas as code — 1:1 with format-spec §3 (config) and §4 (files).
// The schema is defined once here; every other consumer imports these types.
import { z } from 'zod';

// ── shared building blocks ─────────────────────────────────────────────────
const ID_RE = /^[a-z]+-[0-9a-f]{6}$/;
const HASH_RE = /^blake3:[0-9a-f]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const KINDS = [
  'root',
  'section',
  'domain',
  'sub',
  'rule',
  'plan',
  'plan-step',
  'note',
] as const;
export type Kind = (typeof KINDS)[number];

export const WRITERS = ['scanner', 'sync', 'executor', 'human', 'system'] as const;
export type Writer = (typeof WRITERS)[number];

const id = z.string().regex(ID_RE, 'id must match <prefix>-<6 hex>');
const isoDatetime = z.string().regex(ISO_RE, 'must be an ISO-8601 datetime');

export const Base = z.object({
  id,
  kind: z.enum(KINDS),
  title: z.string().min(3).max(120),
  order: z.number().int().optional(),
  created: isoDatetime,
  updated: isoDatetime,
  updated_by: z.enum(WRITERS),
});

// ── anchors (format-spec §4, §5) ───────────────────────────────────────────
export const Anchor = z.object({
  file: z.string().min(1),
  symbol: z.string().optional(),
  span: z.tuple([z.number().int(), z.number().int()]).optional(),
  hash: z.string().regex(HASH_RE, 'hash must be blake3:<16 hex>'),
  dochash: z.string().regex(HASH_RE, 'dochash must be blake3:<16 hex>').optional(),
});
export type Anchor = z.infer<typeof Anchor>;

// ── depth marker (decision 39: shallow coverage is honest, never omitted) ──
const Depth = z.enum(['full', 'shallow']);

// ── the six node kinds (format-spec §4) ────────────────────────────────────
export const RULE_STATUSES = ['ok', 'drift', 'stale'] as const;
export const STEP_STATUSES = ['planned', 'in-progress', 'done', 'blocked'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Status = RuleStatus | StepStatus;

export const Root = Base.extend({
  kind: z.literal('root'),
});

// Dev-planning v2 (decision 55): the two top branches of the pyramid — "Plan" (the living roadmap,
// `plans/_section.md`) and "Code" (domains → rules, `domains/_section.md`). A pure container like
// `root`: a title and a body, no status, no anchors. Its folder name is fixed (`plans`/`domains`),
// so unlike other containers its slug is not derived from the title.
export const Section = Base.extend({
  kind: z.literal('section'),
  branch: z.enum(['plan', 'code']),
  icon: z.string().optional(),
});

export const Domain = Base.extend({
  kind: z.literal('domain'),
  scope: z.array(z.string().min(1)).min(1),
  icon: z.string().optional(),
  depth: Depth.optional(),
});

export const Sub = Base.extend({
  kind: z.literal('sub'),
  scope: z.array(z.string().min(1)).optional(),
  depth: Depth.optional(),
});

export const Rule = Base.extend({
  kind: z.literal('rule'),
  status: z.enum(RULE_STATUSES),
  provenance: z.enum(['agent', 'human', 'mixed']),
  locked: z.boolean().default(false),
  anchors: z.array(Anchor).default([]), // 0 allowed: a rule without code is a declaration
  affects: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  // How deeply this feature has been read (decisions 39 + 56). Absent = whatever the scan produced;
  // `full` = a Deepen pass has been through it, which is what the card shows. Written by the
  // system after the pass, never claimed by the agent.
  depth: Depth.optional(),
});

export const Plan = Base.extend({
  kind: z.literal('plan'),
  goal: z.string().min(1),
  domains: z.array(z.string()).default([]),
});

// A plan-mode content node (dual-mode, decision 54): a section or leaf of a non-code plan (trip,
// recipe, business idea). Title + markdown body, no code anchors, no status — the liveness/drift
// machinery is for `rule` (code) only. `provenance`/`locked` keep human edits inviolable (rule 6).
export const Note = Base.extend({
  kind: z.literal('note'),
  provenance: z.enum(['agent', 'human', 'mixed']),
  locked: z.boolean().default(false),
});

export const PlanStep = Base.extend({
  kind: z.literal('plan-step'),
  status: z.enum(STEP_STATUSES),
  accept: z.array(z.string().min(1)).min(1),
  depends_on: z.array(z.string()).default([]),
  anchors: z.array(Anchor).default([]),
  blocked_reason: z.string().optional(),
});

/** Every node's validated frontmatter (one of the eight kinds). */
export const NodeMeta = z.union([Root, Section, Domain, Sub, Rule, Plan, PlanStep, Note]);
export type NodeMeta = z.infer<typeof NodeMeta>;

export type RootMeta = z.infer<typeof Root>;
export type SectionMeta = z.infer<typeof Section>;
export type DomainMeta = z.infer<typeof Domain>;
export type SubMeta = z.infer<typeof Sub>;
export type RuleMeta = z.infer<typeof Rule>;
export type PlanMeta = z.infer<typeof Plan>;
export type PlanStepMeta = z.infer<typeof PlanStep>;
export type NoteMeta = z.infer<typeof Note>;

const SCHEMA_BY_KIND = {
  root: Root,
  section: Section,
  domain: Domain,
  sub: Sub,
  rule: Rule,
  plan: Plan,
  'plan-step': PlanStep,
  note: Note,
} as const;

/** The zod schema for a given kind (used by parse/validate to give precise errors). */
export function schemaForKind(kind: Kind): (typeof SCHEMA_BY_KIND)[Kind] {
  return SCHEMA_BY_KIND[kind];
}

// ── config.yaml (format-spec §3) ───────────────────────────────────────────
export const Config = z.object({
  format: z.literal(1),
  // Dual-mode (decision 54): 'dev' is the code pipeline (scan → rules → plan → execute); 'plan' is
  // a general-planning project where the agent authors `note` content directly. A soft posture: it
  // drives default agent behaviour + UI chrome, it does not partition the node kinds.
  mode: z.enum(['dev', 'plan']).default('dev'),
  language: z.string().default('en'),
  stack: z.array(z.string()).default([]),
  scan: z
    .object({
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: [], exclude: [] }),
  limits: z
    .object({
      max_rules_per_sub: z.number().int().positive().default(40),
    })
    .default({ max_rules_per_sub: 40 }),
});
export type Config = z.infer<typeof Config>;

export function isRule(meta: NodeMeta): meta is RuleMeta {
  return meta.kind === 'rule';
}
export function isPlanStep(meta: NodeMeta): meta is PlanStepMeta {
  return meta.kind === 'plan-step';
}
export function hasStatus(meta: NodeMeta): meta is RuleMeta | PlanStepMeta {
  return meta.kind === 'rule' || meta.kind === 'plan-step';
}
