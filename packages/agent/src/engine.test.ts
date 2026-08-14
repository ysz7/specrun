// Smoke tests for the SDK tool policy (Phase 2). Dog-fooding surfaced that the two SDK lists were
// conflated: `allowedTools` auto-approves a tool *before* canUseTool is consulted, so listing the
// write tools there silently disabled decision 1 (permission on every file edit / command) while
// restricting nothing. These pin the split so it cannot regress into an auto-approve-everything run.
import { describe, expect, it } from 'vitest';
import { toolPolicy } from './engine.js';
import { AGENT_ROLES, ROLE_TOOLS, sdkToolName, roleEditsCode } from './roles.js';

const WRITE_TOOLS = ['Write', 'Edit', 'Bash'];

describe('toolPolicy', () => {
  it('only the Executor can reach the code-writing tools at all', () => {
    for (const role of AGENT_ROLES) {
      const { available } = toolPolicy(role);
      expect(available).toEqual(
        expect.arrayContaining(['Read', 'Glob', 'Grep', 'ToolSearch']), // read + tool discovery
      );
      for (const tool of WRITE_TOOLS) {
        expect(available.includes(tool)).toBe(roleEditsCode(role));
      }
    }
  });

  it('never auto-approves writing code or running a command (decision 1)', () => {
    for (const role of AGENT_ROLES) {
      const { autoApproved } = toolPolicy(role);
      for (const tool of WRITE_TOOLS) expect(autoApproved).not.toContain(tool);
    }
  });

  it('auto-approves the role’s own validated spec tools, and nothing beyond them', () => {
    for (const role of AGENT_ROLES) {
      const { autoApproved } = toolPolicy(role);
      const mcp = autoApproved.filter((t) => t.startsWith('mcp__'));
      expect(mcp).toEqual(ROLE_TOOLS[role].map(sdkToolName));
    }
  });

  it('grants no tool a role is not allowed to use', () => {
    // The Navigator is read-only (roles §6): it must be unable to touch the code or the spec.
    const navigator = toolPolicy('navigator');
    expect(navigator.available).toEqual(['Read', 'Glob', 'Grep', 'ToolSearch']);
    expect(navigator.autoApproved).toEqual([
      sdkToolName('alethic_read_map'),
      'Read',
      'Glob',
      'Grep',
      'ToolSearch',
    ]);
  });
});
