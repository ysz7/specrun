import { describe, expect, it } from 'vitest';
import { auditForm, LEGACY_FLAG, legacyFormViolation } from './form.js';
import { toIndexEntries, type LoadedNode } from './load.js';
import type { NodeMeta } from './schema.js';

const rule = (id: string, title: string, extra: Partial<NodeMeta> = {}): NodeMeta =>
  ({
    id,
    kind: 'rule',
    title,
    status: 'ok',
    provenance: 'agent',
    locked: false,
    anchors: [],
    affects: [],
    tests: [],
    created: '2026-08-08T00:00:00Z',
    updated: '2026-08-08T00:00:00Z',
    updated_by: 'scanner',
    ...extra,
  }) as NodeMeta;

const node = (path: string, meta: NodeMeta, body: string): LoadedNode => ({
  path,
  meta,
  body,
  conflict: false,
});

const FEATURE_BODY = [
  'Adding a task stores it and confirms it in one line.',
  '',
  '## How it works',
  'cmd_add validates the text and writes through storage.save.',
  '',
  '## Invariants',
  '- ids never repeat',
].join('\n');

describe('legacyFormViolation (the pre-decision-56 unit)', () => {
  it('accepts a feature: a name for a title, a statement and sections for a body', () => {
    expect(legacyFormViolation(rule('r-1', 'Adding a task'), FEATURE_BODY)).toBeNull();
  });

  it('rejects the old unit — the assertion standing in the title', () => {
    const reason = legacyFormViolation(
      rule('r-2', "`add`'s confirmation line appends a due suffix iff `task.due` is truthy"),
      FEATURE_BODY,
    );
    expect(reason).toMatch(/backtick|characters/);
  });

  it('rejects a bare statement with no sections, however well it is titled', () => {
    expect(
      legacyFormViolation(rule('r-3', 'Adding a task'), 'A task is stored and confirmed.'),
    ).toMatch(/no sections/);
  });

  it('a lone "## Drift log" is bookkeeping, not the feature’s substance', () => {
    expect(
      legacyFormViolation(
        rule('r-4', 'Adding a task'),
        'A task is stored.\n\n## Drift log\n- 2026-08-01 sync: the id counter moved',
      ),
    ).toMatch(/no sections/);
  });

  it('only rules carry the form — a container is judged by its own rules (the validator’s)', () => {
    const domain = { ...rule('d-1', 'Cli'), kind: 'domain' } as unknown as NodeMeta;
    expect(legacyFormViolation(domain, 'The command-line surface.')).toBeNull();
  });
});

describe('auditForm', () => {
  const nodes: LoadedNode[] = [
    node('domains/cli/commands/adding-a-task.md', rule('r-1', 'Adding a task'), FEATURE_BODY),
    node(
      'domains/cli/commands/add-persists-the-list-before-printing.md',
      rule('r-2', 'Add persists the full task list before printing.'),
      'It writes then prints.',
    ),
    node(
      'domains/cli/parser/cli-requires-one-of-five-subcommands.md',
      rule('r-3', 'Cli requires exactly one of five subcommands.'),
      'Exactly one subcommand is required.',
    ),
  ];

  it('counts what is still in the old form and where it lives', () => {
    const audit = auditForm(nodes);
    expect(audit.rules).toBe(3);
    expect(audit.legacy.map((l) => l.id)).toEqual(['r-2', 'r-3']);
    expect(audit.byContainer).toEqual({
      'domains/cli/commands': 1,
      'domains/cli/parser': 1,
    });
  });

  it('a map written entirely as features audits clean', () => {
    expect(auditForm([nodes[0]!]).legacy).toEqual([]);
  });
});

// The marker has to reach the card, or "this map is still in the old form" is something the reader
// works out on their own — the silence decision 56 called the worst outcome (Phase 6).
describe('the form marker travels into the index', () => {
  it('flags old-form nodes and leaves features unflagged', () => {
    const entries = toIndexEntries([
      node('domains/cli/commands/adding-a-task.md', rule('r-1', 'Adding a task'), FEATURE_BODY),
      node('domains/cli/commands/old.md', rule('r-2', 'Add persists the list.'), 'It persists.'),
    ]);
    expect(entries[0]!.flags).toBeUndefined();
    expect(entries[1]!.flags).toEqual([LEGACY_FLAG]);
  });
});
