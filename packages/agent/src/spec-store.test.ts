import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchorFor, buildIndex, loadAlethicDir, parse, toIndexEntries } from '@alethic/format';
import { SpecStore, ToolError } from './spec-store.js';

const FIXTURE = join(process.cwd(), 'fixtures/acme-commerce');

describe('SpecStore (MCP tool write path)', () => {
  let tmp: string;
  let store: SpecStore;
  let n = 0;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alethic-store-'));
    cpSync(FIXTURE, tmp, { recursive: true });
    n = 0;
    store = new SpecStore(
      join(tmp, '.alethic'),
      () => '2026-07-12T00:00:00Z',
      (kind) => `${kind === 'section' ? 'sec' : 'r'}-9000${String(++n).padStart(2, '0')}`, // avoid acme ids
    );
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('upsert_rule writes a valid file that parses', async () => {
    const res = await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'New promo rule',
      body: 'A newly discovered rule about promos.',
      anchors: [
        { file: 'src/payments.ts', symbol: 'applyDiscounts', hash: 'blake3:0123456789abcdef' },
      ],
    });
    expect(res.created).toBe(true);
    const abs = join(tmp, '.alethic', res.path);
    expect(existsSync(abs)).toBe(true);
    const parsed = parse(readFileSync(abs, 'utf8'));
    expect(parsed.meta?.kind).toBe('rule');
    expect(parsed.meta?.title).toBe('New promo rule');
  });

  // Windows-vs-POSIX has bitten this codebase twice before (PLAN.md). An anchor.file is a raw
  // string from the agent; `path.join` on POSIX treats `\` as a literal character, not a
  // separator, so an unnormalized backslash path would silently fail to resolve.
  it('a backslash anchor path resolves like its posix equivalent', async () => {
    const res = await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'New promo rule',
      body: 'A newly discovered rule about promos.',
      anchors: [{ file: 'src\\payments.ts', symbol: 'applyDiscounts' }],
    });
    expect(res.created).toBe(true);
    const abs = join(tmp, '.alethic', res.path);
    const parsed = parse(readFileSync(abs, 'utf8'));
    const anchors = (parsed.meta as { anchors?: { file: string }[] } | null)?.anchors ?? [];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.file).toBe('src/payments.ts');
  });

  // Dog-fooding (Phase 2): a run wrote its code outside the project root, and the scanner then
  // recorded rules anchored to files that were not there — the anchors were silently dropped and
  // the map confidently described code that did not exist.
  it('a rule whose anchored files are all missing is rejected, not silently un-anchored', async () => {
    await expect(
      store.upsertRule({
        domain: 'payments',
        sub: 'discounts',
        title: 'Rule about code that is not here',
        body: 'Describes /tmp/todo.py, which this project does not contain.',
        anchors: [{ file: 'todo.py', symbol: 'cmd_add' }, { file: 'storage.py' }],
      }),
    ).rejects.toThrow(/todo\.py, storage\.py/);
  });

  // Dog-fooding (Phase 2.1): the scanner names domains in prose ("Anchoring" / "Hashing"), which
  // landed on disk verbatim — validator slug-mismatch warnings, and a rescan with different
  // capitalisation would fork a second folder for the same domain.
  it('a prose domain/sub name becomes a slug folder, keeping the readable title on the card', async () => {
    const res = await store.upsertRule({
      domain: 'Anchoring & Hashing',
      sub: 'Structural Hashing',
      title: 'Structural hash ignores comments',
      body: 'The hash is computed over the AST, not the text.',
    });
    // Paths inside `.alethic/` are posix everywhere the format speaks them (the loader, the
    // index, the anchors), so the write path answers in the same dialect on every OS.
    expect(res.path).toBe(
      'domains/anchoring-hashing/structural-hashing/structural-hash-ignores-comments.md',
    );
    const card = parse(
      readFileSync(join(tmp, '.alethic', 'domains', 'anchoring-hashing', '_domain.md'), 'utf8'),
    );
    expect(card.meta?.title).toBe('Anchoring & Hashing');
  });

  // Decision 56: the unit of the map is a feature and its title is the feature's NAME. Asking for
  // that in the prompt is not enough — the tool holds the norm, the way it already does for anchors
  // on files that are not there: a structured error the agent must fix and retry.
  it('a title that is an assertion is rejected with a rename hint, not written', async () => {
    const cases = [
      "`add`'s confirmation line appends a due suffix iff `task.due` is truthy and the store is warm",
      'Percentage discounts apply to the subtotal before tax.',
      'Discounting an `Order`',
    ];
    for (const title of cases) {
      await expect(
        store.upsertRule({ domain: 'payments', sub: 'discounts', title, body: 'Statement.' }),
      ).rejects.toThrow(/name, not an assertion/);
    }
    expect(readdirSync(join(tmp, '.alethic', 'domains', 'payments', 'discounts')).sort()).toEqual([
      '_sub.md',
      'discounting-an-order.md',
      'promo-codes.md',
    ]);
  });

  // A live scan produced domain cards literally titled "Node schema &amp; identity" — the model's
  // reply escaped the "&" and it was passed straight through, so the card showed the escape and
  // `slugify` turned it into `…-amp-…`, no longer matching the folder (PLAN.md known issues).
  it('an escaped ampersand in a title is decoded before it is slugged or stored', async () => {
    const res = await store.upsertRule({
      domain: 'Node schema &amp; identity',
      sub: 'Structural hashing',
      title: 'Structural &amp; doc hashing',
      body: 'Computes both hashes in one pass.',
    });
    expect(res.path).toBe(
      'domains/node-schema-identity/structural-hashing/structural-doc-hashing.md',
    );
    const rule = parse(readFileSync(join(tmp, '.alethic', res.path), 'utf8'));
    expect(rule.meta?.title).toBe('Structural & doc hashing');
    const domainCard = parse(
      readFileSync(join(tmp, '.alethic', 'domains', 'node-schema-identity', '_domain.md'), 'utf8'),
    );
    expect(domainCard.meta?.title).toBe('Node schema & identity');
  });

  it('a feature name inside the norm is accepted', async () => {
    const res = await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'Seasonal campaigns',
      body: 'Campaigns discount a whole catalogue for a window of time.',
    });
    expect(res.created).toBe(true);
  });

  // Phase 4 / decision 56: Deepen rewrites a node's body pass after pass. A model that appends its
  // new findings leaves a second "## Invariants" under the first; the write path folds them back.
  it('a repeat Deepen enriches the body instead of stacking a second copy of a section', async () => {
    const first = await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'Seasonal campaigns',
      body: 'Campaigns discount a catalogue for a window.\n\n## Invariants\n- a campaign has an end date',
    });
    const again = await store.upsertRule({
      id: first.id,
      domain: 'payments',
      sub: 'discounts',
      title: 'Seasonal campaigns',
      body:
        'Campaigns discount a catalogue for a window.\n\n## Invariants\n- a campaign has an end date\n\n' +
        '## How it works\nThe scheduler activates them.\n\n## Invariants\n- campaigns never stack with promo codes',
    });
    expect(again.created).toBe(false); // the same node, not a neighbour
    const body = parse(readFileSync(join(tmp, '.alethic', again.path), 'utf8')).body;
    expect(body.match(/## Invariants/g)).toHaveLength(1);
    expect(body).toContain('- a campaign has an end date');
    expect(body).toContain('- campaigns never stack with promo codes');
    expect(body).toContain('## How it works');
  });

  // The folder layout IS the hierarchy (format-spec §6): a leaf's filename is the slug of its
  // title. Renaming a node without renaming its file leaves the two out of step for good — which
  // Phase 6's migration would have done to every node it touched, since re-titling an assertion
  // into a feature name is the whole point of that pass.
  it('a re-titled node is renamed on disk, keeping its id and its place', async () => {
    const before = 'domains/payments/discounts/discounting-an-order.md';
    const res = await store.upsertRule({
      id: 'r-000001',
      domain: 'payments',
      sub: 'discounts',
      title: 'Order discounting',
      body: 'Discounts apply before tax.\n\n## Invariants\n- tax = f(subtotal − discount)',
    });
    expect(res.path).toBe('domains/payments/discounts/order-discounting.md');
    expect(res.created).toBe(false);
    expect(existsSync(join(tmp, '.alethic', before))).toBe(false); // no copy left behind
    expect(readFileSync(join(tmp, '.alethic', res.path), 'utf8')).toContain('id: "r-000001"');
  });

  // Found by the first live Deepen run: the pass came back with a much richer body and an empty
  // `anchors`, and the node — anchored a minute earlier — lost its tie to the code (and its place
  // in by_file, so drift stopped seeing it). Enriching a node never costs it anchors.
  it('an update that mentions no anchors keeps the ones the node already has', async () => {
    const path = 'domains/payments/discounts/discounting-an-order.md';
    const before = parse(readFileSync(join(tmp, '.alethic', path), 'utf8')).meta as unknown as {
      anchors: { symbol?: string }[];
    };
    expect(before.anchors.length).toBeGreaterThan(0);

    await store.upsertRule({
      id: 'r-000001',
      domain: 'payments',
      sub: 'discounts',
      title: 'Discounting an order',
      body: 'A deepened body that forgot to repeat the anchors.\n\n## Invariants\n- tax = f(subtotal − discount)',
    });
    const after = parse(readFileSync(join(tmp, '.alethic', path), 'utf8')).meta as unknown as {
      anchors: { symbol?: string }[];
    };
    expect(after.anchors.map((a) => a.symbol)).toEqual(before.anchors.map((a) => a.symbol));
  });

  it('set_depth records a Deepen pass, and a later upsert does not erase it', async () => {
    store.setDepth('r-000001', 'full');
    const path = 'domains/payments/discounts/discounting-an-order.md';
    expect(readFileSync(join(tmp, '.alethic', path), 'utf8')).toContain('depth: "full"');
    await store.upsertRule({
      id: 'r-000001',
      domain: 'payments',
      sub: 'discounts',
      title: 'Discounting an order',
      body: 'A rescan rewrote the body.',
    });
    expect(readFileSync(join(tmp, '.alethic', path), 'utf8')).toContain('depth: "full"');
    expect(() => store.setDepth('p-000001', 'full')).toThrow(/carries no depth/);
  });

  it('upsert_rule with status drift and no drift log is rejected', async () => {
    await expect(
      store.upsertRule({
        domain: 'payments',
        sub: 'discounts',
        title: 'Drifting rule',
        body: 'No log here.',
        status: 'drift',
      }),
    ).rejects.toThrow(ToolError);
  });

  it('locked/human bodies are inviolable — re-upsert is rejected with a propose_edit hint', async () => {
    const first = await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'Human rule',
      body: 'Written by a human.',
      provenance: 'human',
    });
    await expect(
      store.upsertRule({
        id: first.id,
        domain: 'payments',
        sub: 'discounts',
        title: 'Human rule',
        body: 'Agent overwrite attempt.',
      }),
    ).rejects.toThrow(/locked|propose_edit/);
  });

  // ── growing inward when a feature fills up (Phase 5 / decision 56) ──
  describe('depth: the pyramid grows inward', () => {
    it('writes a feature at any container depth, and keeps the legacy domain+sub pair working', async () => {
      const deep = await store.upsertRule({
        path: ['cli', 'commands', 'add'],
        title: 'Due dates on add',
        body: 'A due date can be given when a task is added.',
      });
      expect(deep.path).toBe('domains/cli/commands/add/due-dates-on-add.md');
      // …and every container on the way exists, so the node has a parent to hang from
      for (const [dir, card] of [
        ['cli', '_domain.md'],
        ['cli/commands', '_sub.md'],
        ['cli/commands/add', '_sub.md'],
      ] as const) {
        expect(existsSync(join(tmp, '.alethic', 'domains', ...dir.split('/'), card))).toBe(true);
      }

      const flat = await store.upsertRule({
        domain: 'payments',
        sub: 'discounts',
        title: 'Seasonal campaigns',
        body: 'Campaigns discount a catalogue for a window.',
      });
      expect(flat.path).toBe('domains/payments/discounts/seasonal-campaigns.md');
    });

    // The conflict decision 56 predicted: the pyramid treats everything that is not a rule as a
    // container, so a feature-with-children would never open. It stops being a leaf instead —
    // keeping its id, so `affects` edges and history survive the regrouping.
    it('a feature that gains children becomes the layer’s roof, with the same id', async () => {
      const leaf = await store.upsertRule({
        path: ['cli', 'commands'],
        title: 'Adding a task',
        body: 'Adds a task and confirms it.\n\n## Invariants\n- ids never repeat',
        anchors: [{ file: 'src/payments.ts', symbol: 'applyDiscounts' }],
      });
      expect(leaf.path).toBe('domains/cli/commands/adding-a-task.md');

      const child = await store.upsertRule({
        path: ['cli', 'commands', 'adding-a-task'],
        title: 'Due dates on add',
        body: 'A due date can be given when a task is added.',
      });

      const roofPath = join('domains', 'cli', 'commands', 'adding-a-task', '_sub.md');
      const roof = parse(readFileSync(join(tmp, '.alethic', roofPath), 'utf8'));
      expect(roof.meta?.id).toBe(leaf.id); // the same node, not a new one
      expect(roof.meta?.kind).toBe('sub');
      expect(roof.body).toContain('Adds a task and confirms it.'); // its assertion is the roof's
      expect((roof.meta as { scope?: string[] }).scope).toEqual(['src/payments.ts']);
      expect(existsSync(join(tmp, '.alethic', leaf.path))).toBe(false); // no duplicate left behind

      // …and the child hangs off it in the index the pyramid renders
      const index = buildIndex(toIndexEntries(loadAlethicDir(join(tmp, '.alethic')).nodes));
      expect(index.nodes[child.id]!.parent).toBe(leaf.id);
    });

    // The corruption this would otherwise be: after the promotion the id denotes a container, so a
    // plain upsert on it would write a rule file over `_sub.md` — and every child under that roof
    // would lose its parent in one write.
    it('a node that became a roof cannot be overwritten as a feature', async () => {
      const leaf = await store.upsertRule({
        path: ['cli', 'commands'],
        title: 'Adding a task',
        body: 'Adds a task.',
      });
      await store.upsertRule({
        path: ['cli', 'commands', 'adding-a-task'],
        title: 'Due dates on add',
        body: 'A due date can be given.',
      });
      await expect(
        store.upsertRule({
          id: leaf.id,
          path: ['cli', 'commands'],
          title: 'Adding a task',
          body: 'Trying to write the roof as a leaf again.',
        }),
      ).rejects.toThrow(/roof of a layer|alethic_upsert_container/);
      expect(
        parse(
          readFileSync(
            join(tmp, '.alethic', 'domains', 'cli', 'commands', 'adding-a-task', '_sub.md'),
            'utf8',
          ),
        ).meta?.kind,
      ).toBe('sub');
    });

    it('move_rule regroups a feature without minting a new id', async () => {
      const before = parse(
        readFileSync(join(tmp, '.alethic', 'domains/payments/discounts/promo-codes.md'), 'utf8'),
      );
      const moved = store.moveRule('r-000002', ['payments', 'discounts', 'discounting-an-order']);
      expect(moved.to).toBe(
        join('domains', 'payments', 'discounts', 'discounting-an-order', 'promo-codes.md'),
      );
      expect(existsSync(join(tmp, '.alethic', moved.from))).toBe(false);
      const after = parse(readFileSync(join(tmp, '.alethic', moved.to), 'utf8'));
      expect(after.meta?.id).toBe('r-000002');
      expect(after.body).toBe(before.body);
      expect((after.meta as { anchors: unknown[] }).anchors).toEqual(
        (before.meta as unknown as { anchors: unknown[] }).anchors,
      );
      // the feature it moved under is now the layer's roof, still r-000001
      const roof = parse(
        readFileSync(
          join(tmp, '.alethic', 'domains/payments/discounts/discounting-an-order/_sub.md'),
          'utf8',
        ),
      );
      expect(roof.meta?.id).toBe('r-000001');
      expect(() => store.moveRule('r-nosuch', ['payments'])).toThrow(/No feature/);
    });

    it('upsert_container gives a layer a roof that asserts, and holds the title norm', () => {
      const res = store.upsertContainer({
        path: ['payments', 'discounts'],
        title: 'Discounts',
        body: 'Everything that lowers what an order costs before tax.',
      });
      expect(res.id).toBe('s-000001'); // the existing card, not a second one
      const card = parse(
        readFileSync(join(tmp, '.alethic', 'domains/payments/discounts/_sub.md'), 'utf8'),
      );
      expect(card.body).toContain('lowers what an order costs');
      expect(() =>
        store.upsertContainer({
          path: ['payments', 'discounts'],
          title: 'Discounts apply to the subtotal before tax.',
          body: 'x',
        }),
      ).toThrow(/name, not an assertion/);
    });
  });

  it('set_status enforces the status machine', () => {
    // ok → stale by system is legal
    expect(store.setStatus('r-000001', 'stale', 'system')).toMatchObject({ to: 'stale' });
    // stale → drift by sync requires a drift log
    expect(() => store.setStatus('r-000001', 'drift', 'sync')).toThrow(/drift log/i);
    store.logDrift('r-000001', 'behaviour changed in commit abc123');
    expect(store.setStatus('r-000001', 'drift', 'sync')).toMatchObject({
      from: 'stale',
      to: 'drift',
    });
  });

  it('set_status rejects an illegal transition (system cannot set drift)', () => {
    expect(() => store.setStatus('r-000002', 'drift', 'system')).toThrow(/illegal|transition/i);
  });

  it('retire_rule moves the file to .backup and removes the original', () => {
    const res = store.retireRule('r-000002', 'obsolete');
    expect(existsSync(join(tmp, '.alethic', res.backupPath))).toBe(true);
    expect(existsSync(join(tmp, '.alethic', 'domains/payments/discounts/promo-codes.md'))).toBe(
      false,
    );
  });

  it('propose_edit stores a proposal without touching the node', () => {
    const before = readFileSync(
      join(tmp, '.alethic', 'domains/payments/discounts/discounting-an-order.md'),
      'utf8',
    );
    const res = store.proposeEdit('r-000001', 'A proposed new body.');
    expect(existsSync(join(tmp, '.alethic', res.proposalPath))).toBe(true);
    const after = readFileSync(
      join(tmp, '.alethic', 'domains/payments/discounts/discounting-an-order.md'),
      'utf8',
    );
    expect(after).toBe(before);
  });

  it('read_map summarizes nodes', () => {
    const map = store.readMap();
    expect(map.counts['rule']).toBeGreaterThanOrEqual(12);
    expect(map.nodes.find((node) => node.id === 'r-000001')?.title).toBe('Discounting an order');
  });

  // ── human editing (Phase 7 / decisions 16, 17) ──
  const RULE = 'domains/payments/discounts/discounting-an-order.md';

  it('saveHuman writes the body and marks the rule human-authored (provenance + updated_by)', () => {
    const before = parse(readFileSync(join(tmp, '.alethic', RULE), 'utf8'));
    const res = store.saveHuman(
      RULE,
      { title: 'Discounting an order', body: 'Human-clarified statement.' },
      before.meta!.updated,
    );
    expect(res.ok).toBe(true);
    const after = parse(readFileSync(join(tmp, '.alethic', RULE), 'utf8'));
    expect(after.body).toContain('Human-clarified statement.');
    expect(after.meta?.updated_by).toBe('human');
    expect((after.meta as { provenance?: string }).provenance).toBe('human');
  });

  it('saveHuman does not change the status (statuses move only through the machine, rule 4)', () => {
    const before = parse(readFileSync(join(tmp, '.alethic', RULE), 'utf8'));
    store.saveHuman(RULE, { body: 'Edited.' }, before.meta!.updated);
    const after = parse(readFileSync(join(tmp, '.alethic', RULE), 'utf8'));
    expect((after.meta as { status?: string }).status).toBe(
      (before.meta as { status?: string }).status,
    );
  });

  it('saveHuman reports a conflict when the file changed on disk, and force overwrites (decision 17)', () => {
    const conflict = store.saveHuman(RULE, { body: 'Stale edit.' }, '1999-01-01T00:00:00Z');
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.body.length).toBeGreaterThan(0); // the disk version, for the reload branch

    const forced = store.saveHuman(RULE, { body: 'Forced edit.' }, '1999-01-01T00:00:00Z', true);
    expect(forced.ok).toBe(true);
    expect(parse(readFileSync(join(tmp, '.alethic', RULE), 'utf8')).body).toContain('Forced edit.');
  });

  // ── planning (Phase 9) ──
  it('upsert_plan writes a valid _plan.md with a goal', () => {
    const res = store.upsertPlan({ slug: 'promo', title: 'Promo codes', goal: 'Ship promo codes' });
    expect(res.path).toBe(join('plans', 'promo', '_plan.md'));
    const parsed = parse(readFileSync(join(tmp, '.alethic', res.path), 'utf8'));
    expect(parsed.meta?.kind).toBe('plan');
    expect((parsed.meta as { goal?: string }).goal).toBe('Ship promo codes');
  });

  // ── the Plan/Code branches (dev-planning v2, decision 55) ──
  it('writing a plan or a rule materializes its section', async () => {
    // A pre-v2 map has no sections; the next write into either tree creates them.
    rmSync(join(tmp, '.alethic', 'plans', '_section.md'));
    rmSync(join(tmp, '.alethic', 'domains', '_section.md'));

    store.upsertPlan({ slug: 'promo', title: 'Promo codes', goal: 'Ship promo codes' });
    const planSection = parse(readFileSync(join(tmp, '.alethic', 'plans', '_section.md'), 'utf8'));
    expect(planSection.meta?.kind).toBe('section');
    expect((planSection.meta as { branch?: string }).branch).toBe('plan');

    await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'A promo rule',
      body: 'Body.',
    });
    const codeSection = parse(
      readFileSync(join(tmp, '.alethic', 'domains', '_section.md'), 'utf8'),
    );
    expect((codeSection.meta as { branch?: string }).branch).toBe('code');
  });

  it('a rule in a fresh domain/sub materializes both cards, so it hangs off the apex', async () => {
    const res = await store.upsertRule({
      domain: 'cli',
      sub: 'parser',
      title: 'CLI requires a subcommand',
      body: 'The CLI rejects an invocation with no subcommand.',
      anchors: [
        { file: 'src/payments.ts', symbol: 'applyDiscounts', hash: 'blake3:0123456789abcdef' },
      ],
    });
    const domainCard = parse(
      readFileSync(join(tmp, '.alethic', 'domains', 'cli', '_domain.md'), 'utf8'),
    );
    expect(domainCard.meta?.kind).toBe('domain');
    expect((domainCard.meta as { scope?: string[] }).scope).toEqual(['src/payments.ts']);
    expect(
      parse(readFileSync(join(tmp, '.alethic', 'domains', 'cli', 'parser', '_sub.md'), 'utf8')).meta
        ?.kind,
    ).toBe('sub');

    // …and the rule is reachable from the root in the index the pyramid renders.
    const { nodes } = loadAlethicDir(join(tmp, '.alethic'));
    const index = buildIndex(toIndexEntries(nodes));
    const chain = [];
    for (let id = index.nodes[res.id]?.parent; id; id = index.nodes[id]?.parent) chain.push(id);
    expect(chain.map((id) => index.nodes[id]!.kind)).toEqual(['sub', 'domain', 'section', 'root']);
  });

  it('re-derives anchor hashes itself — an agent-supplied hash never reaches the file', async () => {
    const source = readFileSync(join(tmp, 'src', 'payments.ts'), 'utf8');
    const real = await anchorFor('src/payments.ts', source, 'applyDiscounts');
    const res = await store.upsertRule({
      domain: 'payments',
      sub: 'discounts',
      title: 'Anchored rule',
      body: 'Statement.',
      // what an agent hand-computes over a line range — plausible shape, wrong value
      anchors: [
        { file: 'src/payments.ts', symbol: 'applyDiscounts', hash: 'blake3:deadbeefdeadbeef' },
      ],
    });
    const written = parse(readFileSync(join(tmp, '.alethic', res.path), 'utf8'));
    const anchor = (written.meta as { anchors: { hash: string }[] }).anchors[0]!;
    expect(anchor.hash).toBe(real!.hash);
    expect(anchor.hash).not.toBe('blake3:deadbeefdeadbeef');
  });

  it('ensure_section is idempotent — the id survives a second call', () => {
    rmSync(join(tmp, '.alethic', 'domains', '_section.md'));
    const first = store.ensureSection('code');
    const second = store.ensureSection('code');
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, path: first.path, created: false });
  });

  it('set_thesis rewrites the root body (greenfield apex, decision 29)', () => {
    const res = store.setThesis('A living map of a promo-code engine.');
    expect(res.id).toBeTruthy();
    const root = parse(readFileSync(join(tmp, '.alethic', 'alethic.md'), 'utf8'));
    expect(root.meta?.kind).toBe('root');
    expect(root.body).toContain('promo-code engine');
  });
});
