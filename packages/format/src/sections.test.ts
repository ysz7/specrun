import { describe, expect, it } from 'vitest';
import { describePlace, locateInBody, mergeDuplicateSections, parseSections } from './sections.js';

describe('parseSections', () => {
  it('splits a feature body into its statement and sections', () => {
    const { statement, sections } = parseSections(
      'Adding a task stores it and confirms it.\n\n## How it works\ncmd_add writes through storage.\n\n## Invariants\n- ids never repeat\n',
    );
    expect(statement).toBe('Adding a task stores it and confirms it.');
    expect(sections.map((s) => s.heading)).toEqual(['How it works', 'Invariants']);
    expect(sections[1]!.lines.join('\n')).toContain('- ids never repeat');
  });

  it('a body with no sections is all statement', () => {
    expect(parseSections('Just a statement.').sections).toEqual([]);
  });
});

// Deepen rewrites a node's body pass after pass (decision 56). A model that appends its findings
// leaves a second "## Invariants" under the first — the write path folds them back together.
describe('mergeDuplicateSections (repeat Deepen)', () => {
  it('folds a repeated section into the first one, keeping the new lines', () => {
    const merged = mergeDuplicateSections(
      [
        'A feature.',
        '',
        '## Invariants',
        '- ids never repeat',
        '',
        '## Edge cases',
        '- empty input is rejected',
        '',
        '## Invariants',
        '- ids never repeat',
        '- the counter starts at 1',
      ].join('\n'),
    );
    expect(merged.match(/## Invariants/g)).toHaveLength(1);
    expect(merged).toContain('- ids never repeat');
    expect(merged).toContain('- the counter starts at 1');
    expect(merged.indexOf('## Invariants')).toBeLessThan(merged.indexOf('## Edge cases'));
    // the duplicate line arrived once, not twice
    expect(merged.match(/- ids never repeat/g)).toHaveLength(1);
  });

  it('matches headings case-insensitively and leaves a clean body untouched', () => {
    const clean = 'A feature.\n\n## How it works\nIt works.\n\n## Invariants\n- one';
    expect(mergeDuplicateSections(clean)).toBe(clean);
    expect(
      mergeDuplicateSections('A feature.\n\n## Invariants\n- one\n\n## INVARIANTS\n- two').match(
        /^##/gm,
      ),
    ).toHaveLength(1);
  });

  it('keeps a body that has no sections as it is', () => {
    expect(mergeDuplicateSections('Just a statement.\n')).toBe('Just a statement.');
  });

  it('a "## " inside a fenced block is code, not a heading', () => {
    const body = 'A feature.\n\n## How it works\n```py\n## not a heading\nx = 1\n```\n';
    expect(parseSections(body).sections.map((s) => s.heading)).toEqual(['How it works']);
    const merged = mergeDuplicateSections(body);
    expect(merged).toContain('## not a heading'); // survives as content of the one section
    expect(merged).toContain('x = 1');
  });
});

// Decision 56 accepted a blunter drift signal as the price of the feature unit, and named the
// compensation: tie the change to the place inside the feature that describes it. Derived, not
// declared — so it works on every feature already on disk (Phase 6).
describe('locateInBody (which part of a feature moved)', () => {
  const body = [
    'Adding a task stores it and confirms it in one line.',
    '',
    '## How it works',
    'cmd_add validates the text and writes through storage.save.',
    '',
    '## Invariants',
    '- next_id increases monotonically',
    '- empty text is rejected',
  ].join('\n');

  it('names the section that talks about the symbol', () => {
    expect(locateInBody(body, 'cmd_add')).toEqual({ where: 'section', heading: 'How it works' });
    expect(locateInBody(body, 'next_id')).toEqual({ where: 'section', heading: 'Invariants' });
    expect(describePlace(locateInBody(body, 'next_id')!)).toBe('## Invariants');
  });

  it('falls back to the opening statement, and admits when nothing mentions it', () => {
    expect(
      locateInBody(
        'applyDiscounts is the whole feature.\n\n## Invariants\n- one',
        'applyDiscounts',
      ),
    ).toEqual({
      where: 'statement',
    });
    expect(locateInBody(body, 'refundCapture')).toBeNull();
  });

  it('matches whole symbols only — `save` is not `storage.save`’s neighbour `saveAll`', () => {
    const b = 'A feature.\n\n## How it works\nIt calls saveAll and nothing else.';
    expect(locateInBody(b, 'save')).toBeNull();
    expect(locateInBody(b, 'saveAll')).toEqual({ where: 'section', heading: 'How it works' });
  });
});
