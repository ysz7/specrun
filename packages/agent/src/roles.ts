// The five agent roles (implementation-plan §2.2) and the MCP tools each may call
// (agent-prompts-spec §6). One agent, five system prompts, different write rights.
// `plan-author` is the dual-mode (decision 54) content role: in a plan-mode project it writes
// `note` sections directly (no code, no plan/execute pipeline).
export const AGENT_ROLES = [
  'scanner',
  'sync',
  'planner',
  'executor',
  'navigator',
  'plan-author',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** MCP tool names exposed to the agent (all prefixed `alethic_`). */
export const MCP_TOOLS = [
  'alethic_read_map',
  'alethic_upsert_rule',
  'alethic_move_rule',
  'alethic_upsert_container',
  'alethic_retire_rule',
  'alethic_set_status',
  'alethic_log_drift',
  'alethic_propose_edit',
  'alethic_upsert_plan',
  'alethic_set_thesis',
  'alethic_upsert_note',
] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];

/** Which tools each role is allowed to call (§6 contract). Navigator is read-only. */
export const ROLE_TOOLS: Record<AgentRole, readonly McpToolName[]> = {
  // The scanner is the only role that shapes the Code branch: it writes features, groups them into
  // layers when one fills up (move + the layer's own card, decision 56) and retires what the code
  // no longer has.
  scanner: [
    'alethic_read_map',
    'alethic_upsert_rule',
    'alethic_move_rule',
    'alethic_upsert_container',
    'alethic_retire_rule',
    'alethic_propose_edit',
  ],
  sync: ['alethic_read_map', 'alethic_set_status', 'alethic_log_drift', 'alethic_propose_edit'],
  // Dev-planning v2 (decision 55): the Planner maintains ONE plan document (phases + checkboxes) —
  // no per-step files. The Executor implements a phase in code; the map catches up by scanning.
  planner: ['alethic_read_map', 'alethic_upsert_plan', 'alethic_set_thesis'],
  executor: ['alethic_read_map'], // writes code, not spec — the map catches up by scanning
  navigator: ['alethic_read_map'],
  'plan-author': [
    'alethic_read_map',
    'alethic_set_thesis',
    'alethic_upsert_note',
    'alethic_propose_edit',
  ],
};

/** The full SDK tool name as the agent sees it: `mcp__<server>__<tool>`. */
export const MCP_SERVER_NAME = 'alethic' as const;
export const sdkToolName = (tool: McpToolName): string => `mcp__${MCP_SERVER_NAME}__${tool}`;

/** Whether a role may write code files (only the Executor edits the project's own code). */
export function roleEditsCode(role: AgentRole): boolean {
  return role === 'executor';
}
