// Wrap the SpecStore operations as in-process MCP tools for the Agent SDK. The agent can only
// write through these; each validates via the store and returns a structured error on failure
// (agent-prompts-spec §6). Tool names are `alethic_*`; the SDK exposes them as mcp__alethic__*.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MCP_SERVER_NAME } from './roles.js';
import { ToolError, type SpecStore } from './spec-store.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const fail = (err: unknown): ToolResult => {
  const code = err instanceof ToolError ? err.code : 'error';
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
};

// The agent says WHAT it anchors to (file + symbol); the hash is ours to compute (format-spec §5) —
// it is a structural hash over a tree-sitter parse, which the agent has no way to reproduce. Asking
// it for one only invites an invented value, so `hash` is optional here and re-derived on write.
const anchorSchema = z.object({
  file: z.string().describe('repo-relative path'),
  symbol: z.string().optional().describe('the symbol this rule is about, e.g. "applyDiscounts"'),
  span: z.tuple([z.number(), z.number()]).optional(),
  hash: z.string().optional().describe('leave empty — the tool computes it from the code'),
  dochash: z.string().optional(),
});

/** Build the `alethic` MCP server bound to one project's SpecStore. */
export function createAlethicMcpServer(store: SpecStore) {
  const readMap = tool(
    'alethic_read_map',
    'Read a summary of the current map (nodes, kinds, statuses). Read-only.',
    { scope: z.string().optional() },
    async ({ scope }) => {
      try {
        return ok(store.readMap(scope));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const upsertRule = tool(
    'alethic_upsert_rule',
    'Create or update a FEATURE node of the map (decision 56): one capability of the code, not one assertion about it. Validates schema, the title norm, status transitions and locked-protection.',
    {
      id: z.string().optional(),
      path: z
        .array(z.string())
        .optional()
        .describe(
          'the containers this feature hangs under, outermost first: ["cli","commands"]. Any depth (decision 56) — a feature that filled up becomes a layer and its sub-features go one level deeper.',
        ),
      domain: z.string().optional().describe('the two-segment form of `path` (use path instead)'),
      sub: z.string().optional(),
      title: z
        .string()
        .describe(
          'the feature’s NAME — ≤70 chars, no trailing period, no backticked code ("Adding a task", not "`add` appends a due suffix when task.due is set")',
        ),
      body: z
        .string()
        .describe(
          'the statement/responsibility on the first line, then the sections that apply: ## How it works, ## Where it is used, ## Invariants (where small assertions live), ## Edge cases',
        ),
      status: z.enum(['ok', 'drift', 'stale']).optional(),
      provenance: z.enum(['agent', 'human', 'mixed']).optional(),
      anchors: z.array(anchorSchema).optional(),
      affects: z.array(z.string()).optional(),
      tests: z.array(z.string()).optional(),
    },
    async (input) => {
      try {
        return ok(await store.upsertRule(input, 'scanner'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Regrouping is a move, not a rewrite (decision 56): the id carries the node's history, its
  // `affects` edges and its drift log, so a "move" that re-creates the node severs all of them.
  const moveRule = tool(
    'alethic_move_rule',
    'Move a feature under a different container path, keeping its id, body and anchors. Use this to regroup features into a new layer instead of writing a copy and retiring the original.',
    {
      id: z.string(),
      path: z
        .array(z.string())
        .describe('the new container path, outermost first: ["cli","commands","add"]'),
    },
    async ({ id, path }) => {
      try {
        return ok(store.moveRule(id, path, 'scanner'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const upsertContainer = tool(
    'alethic_upsert_container',
    'Write the card of a container (a domain or a layer of features): its name and, in the body, what its children have in common. A layer whose roof only names a folder is not a thought — decision 56 requires the parent of 3–7 siblings to assert something.',
    {
      path: z.array(z.string()).describe('the container path, outermost first: ["cli","commands"]'),
      title: z.string().describe('the container’s NAME — same norm as a feature title'),
      body: z
        .string()
        .describe(
          'what these children have in common — a summarizing statement, not a folder name',
        ),
      scope: z
        .array(z.string())
        .optional()
        .describe('glob masks of the code this container covers'),
    },
    async (input) => {
      try {
        return ok(store.upsertContainer(input, 'scanner'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const retireRule = tool(
    'alethic_retire_rule',
    'Retire a rule (moved to .backup/, not deleted).',
    { id: z.string(), reason: z.string() },
    async ({ id, reason }) => {
      try {
        return ok(store.retireRule(id, reason));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const setStatus = tool(
    'alethic_set_status',
    'Change a node status through the status machine (format-spec §1.2).',
    {
      id: z.string(),
      status: z.enum(['ok', 'drift', 'stale', 'planned', 'in-progress', 'done', 'blocked']),
      by: z.enum(['scanner', 'sync', 'executor', 'system']),
    },
    async ({ id, status, by }) => {
      try {
        return ok(store.setStatus(id, status, by));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const logDrift = tool(
    'alethic_log_drift',
    'Append an entry to a rule’s ## Drift log (required before setting status: drift).',
    { id: z.string(), entry: z.string() },
    async ({ id, entry }) => {
      try {
        return ok(store.logDrift(id, entry));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const proposeEdit = tool(
    'alethic_propose_edit',
    'Propose a new body for a locked/human/mixed node (stored as a proposal, never overwritten).',
    { id: z.string(), body: z.string() },
    async ({ id, body }) => {
      try {
        return ok(store.proposeEdit(id, body));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const upsertPlan = tool(
    'alethic_upsert_plan',
    'Create or update a plan container (_plan.md) with a one-phrase goal and affected domains.',
    {
      id: z.string().optional(),
      slug: z.string(),
      title: z.string(),
      goal: z.string(),
      domains: z.array(z.string()).optional(),
      body: z.string().optional(),
    },
    async (input) => {
      try {
        return ok(store.upsertPlan(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const setThesis = tool(
    'alethic_set_thesis',
    'Set the project apex thesis in alethic.md (greenfield: the Planner writes the top of the pyramid).',
    { text: z.string() },
    async ({ text }) => {
      try {
        return ok(store.setThesis(text));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const upsertNote = tool(
    'alethic_upsert_note',
    'Plan-mode only: create or update a content note (a section or leaf of a non-code plan — trip, recipe, business idea). Title + markdown body; parent is another note id or omitted for a top-level section. Writes real content directly into the map.',
    {
      id: z.string().optional(),
      parent: z.string().optional(),
      title: z.string(),
      body: z.string(),
    },
    async (input) => {
      try {
        return ok(store.upsertNote(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      readMap,
      upsertRule,
      moveRule,
      upsertContainer,
      retireRule,
      setStatus,
      logDrift,
      proposeEdit,
      upsertPlan,
      setThesis,
      upsertNote,
    ],
  });
}
