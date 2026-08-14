import { describe, expect, it } from 'vitest';
import {
  buildDeepenPrompt,
  buildMigrationPrompt,
  buildPrompt,
  type DeepenTarget,
  type MigrationTarget,
} from './prompts.js';
import { AGENT_ROLES, ROLE_TOOLS, sdkToolName } from './roles.js';

describe('role prompts', () => {
  it('composes all documented blocks for every role', () => {
    for (const role of AGENT_ROLES) {
      const prompt = buildPrompt(role);
      for (const block of [
        '[IDENTITY]',
        '[CONTEXT]',
        '[TOOLS]',
        '[PROCEDURE]',
        '[CONSTRAINTS]',
        '[OUTPUT]',
        '[LANGUAGE]',
      ]) {
        expect(prompt).toContain(block);
      }
      // the role's allowed tools are named in the TOOLS block
      for (const t of ROLE_TOOLS[role]) expect(prompt).toContain(sdkToolName(t));
    }
  });

  it('carries the language setting and the cross-cutting truth constraint', () => {
    expect(buildPrompt('scanner', { language: 'ru' })).toContain('"ru"');
    expect(buildPrompt('navigator')).toContain('Truth over completeness');
  });

  it('navigator is read-only (only alethic_read_map)', () => {
    expect(ROLE_TOOLS.navigator).toEqual(['alethic_read_map']);
  });

  it('sync carries the three-verdict few-shot (agent-prompts-spec §2)', () => {
    const prompt = buildPrompt('sync');
    expect(prompt).toContain('[DEFINITIONS]');
    for (const verdict of ['cosmetic', 'behavior-changed', 'rule-outdated']) {
      expect(prompt).toContain(verdict);
    }
  });

  // Decision 56: the unit of the map is a feature, and the scanner writes into the map that is
  // already there (it must read it before its first write, not describe files from scratch).
  it('scanner asks for features, not assertion-shaped nodes (decision 56)', () => {
    const prompt = buildPrompt('scanner');
    expect(prompt).toContain('FEATURE');
    for (const section of ['## How it works', '## Where it is used', '## Invariants'])
      expect(prompt).toContain(section);
    expect(prompt).toContain('no trailing period, no backticked code');
    expect(prompt).toContain('3–7 children');
    // …and the old per-assertion wording is gone for good
    expect(prompt).not.toContain('A rule is an assertion');
    expect(prompt).not.toContain('Split into subdomains.');
  });

  it('scanner must read the existing map before its first write (decision 56 / constitution)', () => {
    const prompt = buildPrompt('scanner');
    expect(prompt).toMatch(/FIRST, before any write: call alethic_read_map/);
  });

  it('shallow scan trades depth, never coverage (decision 39)', () => {
    const prompt = buildPrompt('scanner', { depth: 'shallow' });
    expect(prompt).toContain('[DEPTH]');
    expect(prompt).toContain('3–7 features per subdomain');
    expect(prompt).toContain('Coverage of the scope stays 100%');
  });

  it('navigator routes intents and uses the [[PLAN]] proposal marker (agent-prompts-spec §5)', () => {
    const prompt = buildPrompt('navigator');
    expect(prompt).toContain('[[PLAN]]');
    expect(prompt).toContain('/ask');
    expect(prompt).toContain('/plan');
    expect(prompt.toLowerCase()).toContain('drift'); // the drift/stale caveat
  });
});

// Deepen (decision 56): enrich the node the user clicked — its own body, deeper — instead of
// splitting it into neighbours, which is what the old "split it into finer rules" prompt did.
describe('buildDeepenPrompt', () => {
  const feature: DeepenTarget = {
    id: 'r-9be1f2',
    kind: 'rule',
    title: 'Adding a task',
    path: 'domains/cli/commands/adding-a-task.md',
    body: '`todo add <text>` stores a task.\n\n## Invariants\n- ids never repeat',
    containers: ['cli', 'commands'],
    slug: 'adding-a-task',
    anchors: [{ file: 'todo/cli.py', symbol: 'cmd_add' }],
    parent: { title: 'Commands', statement: 'What the CLI can be asked to do.' },
    siblings: ['Listing tasks', 'Completing a task'],
  };

  it('hands the agent the node it is deepening: body, anchors, parent and siblings', () => {
    const prompt = buildDeepenPrompt(feature);
    expect(prompt).toContain('Adding a task');
    expect(prompt).toContain('`todo add <text>` stores a task.'); // the body it must extend
    expect(prompt).toContain('- ids never repeat');
    expect(prompt).toContain('todo/cli.py · cmd_add');
    expect(prompt).toContain('Parent: Commands — What the CLI can be asked to do.');
    expect(prompt).toContain('Listing tasks');
  });

  it('asks for one write back onto the same node, with the sections of a feature body', () => {
    const prompt = buildDeepenPrompt(feature);
    expect(prompt).toContain('alethic_upsert_rule(id: "r-9be1f2", path: ["cli","commands"]');
    for (const section of [
      '## How it works',
      '## Where it is used',
      '## Invariants',
      '## Edge cases',
    ])
      expect(prompt).toContain(section);
  });

  it('forbids breeding neighbours and duplicating sections (the Phase 4 contract)', () => {
    const prompt = buildDeepenPrompt(feature);
    expect(prompt).toContain('Do not create sibling nodes');
    expect(prompt).toContain('never a second "## Invariants"');
    expect(prompt).not.toContain('split it into finer rules');
  });

  // Phase 5 / decision 56: the one case where the node gains children — the code behind it holds
  // more than ~7 independent sub-features, so the pyramid grows inward instead of the body growing
  // longer. The children go one level deeper, under this node's own slug.
  // Live runs (Phase 5) showed why the shape decision has to come FIRST: with the overflow case
  // as a closing paragraph after "write it back with ONE call", a node standing for a whole package
  // still came back as one longer body. The pass now judges the shape before it writes anything.
  it('makes the agent choose the shape before writing, and names both modes', () => {
    const prompt = buildDeepenPrompt(feature);
    expect(prompt.indexOf('STEP 1')).toBeLessThan(prompt.indexOf('MODE A'));
    expect(prompt).toContain('DECIDE what this node is, before you write anything');
    expect(prompt).toContain('up to ~7 themes');
    expect(prompt).toContain('more than ~7');
    expect(prompt).toContain('Say which mode you chose');
  });

  it('MODE B grows the layer under this node, roof last and by its own tool', () => {
    const prompt = buildDeepenPrompt(feature);
    expect(prompt).toContain('MODE B');
    expect(prompt).toContain(
      '3–7 sub-features with alethic_upsert_rule at path ["cli","commands","adding-a-task"]',
    );
    expect(prompt).toContain('alethic_upsert_container(path: ["cli","commands","adding-a-task"]');
    expect(prompt).toContain('Use that tool, not upsert_rule');
    expect(prompt).toContain('coverage is never traded');
  });

  it('tells the agent how far the node already spreads', () => {
    expect(buildDeepenPrompt(feature)).toContain('1 symbol across 1 file');
    expect(
      buildDeepenPrompt({
        ...feature,
        anchors: [
          { file: 'a.py', symbol: 'x' },
          { file: 'a.py', symbol: 'y' },
          { file: 'b.py', symbol: 'z' },
        ],
      }),
    ).toContain('3 symbols across 2 files');
  });

  it('a container is deepened by filling it with features, not by rewriting a body it has none of', () => {
    const prompt = buildDeepenPrompt({ ...feature, kind: 'sub', body: 'The commands group.' });
    expect(prompt).toContain('Deepen the branch');
    expect(prompt).toContain('alethic_read_map');
    expect(prompt).toContain('FEATURES');
    expect(prompt).not.toContain('alethic_upsert_rule(id:');
  });
});

// Phase 6: a map scanned before decision 56 is a column of sentence-shaped nodes. Migration folds
// them into features *keeping their ids* — a clean rescan would mint new ones and sever the history,
// the `affects` edges and the drift log that hang from them.
describe('buildMigrationPrompt', () => {
  const branch: MigrationTarget = {
    title: 'Commands',
    path: 'domains/cli/commands/_sub.md',
    containers: ['cli', 'commands'],
    children: [
      {
        id: 'r-000001',
        title: 'Add persists the full task list before printing.',
        body: 'It writes the list, then prints the confirmation.',
        anchors: [{ file: 'todo/cli.py', symbol: 'cmd_add' }],
        legacy: 'title ends with a period',
      },
      {
        id: 'r-000002',
        title: "`add`'s confirmation line prints the id",
        body: 'The confirmation names the new id.',
        anchors: [{ file: 'todo/cli.py', symbol: 'cmd_add' }],
        legacy: 'title contains backticked code',
      },
      {
        id: 'r-000003',
        title: 'Listing tasks',
        body: 'Lists open tasks.\n\n## Invariants\n- --all and --done are exclusive',
        anchors: [{ file: 'todo/cli.py', symbol: 'cmd_list' }],
        legacy: null,
      },
    ],
  };

  it('shows the agent every node under the branch, with its id, anchors and body', () => {
    const prompt = buildMigrationPrompt(branch);
    expect(prompt).toContain('r-000001 — "Add persists the full task list before printing."');
    expect(prompt).toContain('todo/cli.py · cmd_add');
    expect(prompt).toContain('It writes the list, then prints the confirmation.');
    expect(prompt).toContain('3 nodes');
    // a node that is already a feature is shown as context, not as something to redo
    expect(prompt).toContain('r-000003 — "Listing tasks"  [already a feature]');
  });

  it('demands the ids be reused, not reinvented — that is the whole point of consolidating', () => {
    const prompt = buildMigrationPrompt(branch);
    expect(prompt).toContain('alethic_upsert_rule(id: <the id of the node it grew out of>');
    expect(prompt).toContain('Reuse an id, never invent one');
    expect(prompt).toMatch(/history, its affects edges and its drift log/);
  });

  it('leaves nothing of the old form standing: retire what was absorbed, roof the branch', () => {
    const prompt = buildMigrationPrompt(branch);
    expect(prompt).toContain('alethic_retire_rule(id, reason: "folded into');
    expect(prompt).toContain('two forms at once');
    expect(prompt).toContain('alethic_upsert_container(path: ["cli","commands"]');
    expect(prompt).toContain('## Invariants'); // the old sentences survive as invariants
  });

  it('reads the map and the code first, and stays inside the branch', () => {
    const prompt = buildMigrationPrompt(branch);
    expect(prompt.indexOf('alethic_read_map')).toBeLessThan(prompt.indexOf('STEP 2'));
    expect(prompt).toContain('stay inside this branch');
    expect(prompt).toContain('locked / provenance: human'); // rule 6 is not negotiable here either
    expect(prompt).toContain('Aim for 3–7 features');
  });
});
