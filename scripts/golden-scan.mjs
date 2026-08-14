// pnpm golden:scan [ts|polyglot] [--produced <dir>] [--runs N]
//
// Phase 5 golden regression (agent-prompts-spec §7). Always builds the deterministic repo-map.
// Then either scores a pre-produced .alethic map (--produced) or runs the Scanner ×N against a
// live Claude (needs a Claude Code OAuth session or ANTHROPIC_API_KEY), scoring each run and
// writing a JSONL report. The live path can't run in CI — the scoring logic is unit-tested in
// packages/scan; this harness is the calibration tool (§8) you run with real access.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRepoMap,
  repoMapDigest,
  scoreScan,
  loadProducedRules,
  DEFAULT_THRESHOLDS,
  loadSyncCases,
  scoreSyncCases,
  SYNC_VERDICTS,
} from '../packages/scan/dist/index.js';

const GOLDENS = {
  ts: {
    src: 'fixtures/golden/acme-commerce-src',
    expected: 'fixtures/golden/expected/acme-commerce-ts.json',
  },
  polyglot: {
    src: 'fixtures/golden/polyglot-src',
    expected: 'fixtures/golden/expected/polyglot.json',
  },
};

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'ts';
const producedIdx = args.indexOf('--produced');
const produced = producedIdx >= 0 ? args[producedIdx + 1] : null;
const runsIdx = args.indexOf('--runs');
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 3;

// ── sync mode: judge the Sync agent on the sync-cases (agent-prompts-spec §7.4) ──
if (name === 'sync') {
  const cases = loadSyncCases('fixtures/golden/sync-cases');
  const reportDir = 'fixtures/golden/reports';
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(
    reportDir,
    `sync-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  const append = (obj) => writeFileSync(reportPath, `${JSON.stringify(obj)}\n`, { flag: 'a' });
  console.log(`\n▶ golden:scan sync — ${cases.length} cases`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n  No live Claude access (ANTHROPIC_API_KEY unset).');
    console.log(
      '  The sync-case scoring is unit-tested in packages/scan; connect Claude to grade the agent.\n',
    );
    process.exit(0);
  }

  const { SdkAgentEngine, buildPrompt } = await import('../packages/agent/dist/index.js');
  const engine = new SdkAgentEngine();
  const verdicts = new Map();
  for (const c of cases) {
    const prompt = `${buildPrompt('sync')}

A rule went stale. Judge it and reply with ONLY JSON: {"verdict":"cosmetic"|"behavior-changed"|"rule-outdated"}.

Rule: ${c.rule}
Anchor: ${c.file} · ${c.symbol}${c.commit ? `\nCommit: ${c.commit}` : ''}

--- old code ---
${c.old}
--- new code ---
${c.new}`;
    let text = '';
    for await (const ev of engine.run({
      role: 'sync',
      model: process.env.ALETHIC_MODEL ?? 'claude-sonnet-5',
      prompt,
      cwd: process.cwd(),
    })) {
      if (ev.type === 'text') text += ev.text;
      if (ev.type === 'done' || ev.type === 'error') break;
    }
    const m = text.match(/"verdict"\s*:\s*"([a-z-]+)"/);
    const got = m && SYNC_VERDICTS.includes(m[1]) ? m[1] : undefined;
    if (got) verdicts.set(c.key, got);
    console.log(
      `  ${got === c.verdict ? '✓' : '✗'} ${c.key}: ${got ?? '∅'} (expected ${c.verdict})`,
    );
  }
  const score = scoreSyncCases(cases, verdicts);
  append({ kind: 'sync-score', ...score });
  console.log(
    `\n  accuracy=${(score.accuracy * 100).toFixed(0)}%  traps=${score.trapCorrect}/${score.trapTotal}  ${score.pass ? '✅ trap gate passed' : '❌ trap gate failed'}\n`,
  );
  process.exit(score.pass ? 0 : 1);
}

const golden = GOLDENS[name];
if (!golden) {
  console.error(`Unknown golden "${name}". Use: ts | polyglot | sync`);
  process.exit(2);
}

const expected = JSON.parse(readFileSync(golden.expected, 'utf8'));
const reportDir = 'fixtures/golden/reports';
mkdirSync(reportDir, { recursive: true });
const reportPath = join(
  reportDir,
  `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
);
const append = (obj) => writeFileSync(reportPath, `${JSON.stringify(obj)}\n`, { flag: 'a' });

console.log(`\n▶ golden:scan ${name}`);
const map = await buildRepoMap(golden.src);
console.log(
  `  repo-map: ${map.files.length} files, ${map.domains.length} domain candidates, ${map.tests.length} test files`,
);
append({
  kind: 'repo-map',
  name,
  files: map.files.length,
  domains: map.domains.map((d) => d.slug),
});

function report(run, score) {
  const flag = score.pass ? 'PASS' : 'FAIL';
  console.log(
    `  run ${run}: ${flag}  coverage=${(score.coverage * 100).toFixed(0)}%  hallucinations=${score.hallucinations}  anchors=${(score.anchorAccuracy * 100).toFixed(0)}%  fragmentation=${score.fragmentation.toFixed(2)}×` +
      (score.titleViolations.length ? `  assertion-titles=${score.titleViolations.length}` : '') +
      (score.missing.length ? `  missing=[${score.missing.join(', ')}]` : ''),
  );
  append({ kind: 'score', run, ...score });
}

// ── mode A: score a pre-produced .alethic map ──
if (produced) {
  const dir = existsSync(join(produced, '.alethic')) ? join(produced, '.alethic') : produced;
  report(1, scoreScan(loadProducedRules(dir), expected, DEFAULT_THRESHOLDS));
  console.log(`\n  report → ${reportPath}\n`);
  process.exit(0);
}

// ── mode B: run the Scanner live ×N ──
if (!process.env.ANTHROPIC_API_KEY) {
  console.log('\n  No live Claude access (ANTHROPIC_API_KEY unset and no OAuth env).');
  console.log(
    '  Re-run with `--produced <projectDir>` to score an existing map, or connect Claude and re-run.',
  );
  console.log(`\n  repo-map digest written → ${reportPath}\n`);
  append({ kind: 'digest', text: repoMapDigest(map) });
  process.exit(0);
}

const { SdkAgentEngine } = await import('../packages/agent/dist/index.js');
const TS = '2026-07-14T00:00:00Z';

let allPass = true;
for (let run = 1; run <= runs; run++) {
  const tmp = mkdtempSync(join(tmpdir(), `golden-${name}-`));
  cpSync(golden.src, tmp, { recursive: true });
  // seed .alethic with config + a domain card per expected domain
  mkdirSync(join(tmp, '.alethic', 'domains'), { recursive: true });
  writeFileSync(
    join(tmp, '.alethic', 'config.yaml'),
    'format: 1\nlanguage: en\nstack: []\nscan:\n  include: ["**"]\n  exclude: []\nlimits:\n  max_rules_per_sub: 40\n',
  );
  writeFileSync(
    join(tmp, '.alethic', 'alethic.md'),
    `---\nid: a-000001\nkind: root\ntitle: ${name}\ncreated: ${TS}\nupdated: ${TS}\nupdated_by: scanner\n---\n\nGolden ${name}.\n`,
  );

  const engine = new SdkAgentEngine();
  const digest = repoMapDigest(map);
  for (const domain of expected.domains) {
    const cand = map.domains.find((d) => d.slug === domain);
    const scope = cand ? cand.scope.join(', ') : `${domain}/**`;
    const prompt = `Scan the domain "${domain}" (scope: ${scope}). Read the map first (alethic_read_map), then read the code and record what it DOES as features with alethic_upsert_rule (domain: "${domain}", pick a sub slug) — a named feature with a body, not one node per sentence. Coverage of the scope must be 100%.\n\n${digest}`;
    for await (const ev of engine.run({
      role: 'scanner',
      model: process.env.ALETHIC_MODEL ?? 'claude-sonnet-5',
      prompt,
      cwd: tmp,
    })) {
      if (ev.type === 'error') console.error('   ', ev.message);
      if (ev.type === 'done') break;
    }
  }
  const score = scoreScan(loadProducedRules(join(tmp, '.alethic')), expected, DEFAULT_THRESHOLDS);
  report(run, score);
  allPass = allPass && score.pass;
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `\n  ${allPass ? '✅ all runs passed' : '❌ not all runs passed'} · report → ${reportPath}\n`,
);
process.exit(allPass ? 0 : 1);
