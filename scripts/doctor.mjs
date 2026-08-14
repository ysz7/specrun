// pnpm doctor — the preflight for a fresh clone.
//
// The build is rarely what stops someone from running Alethic: the app drives a real Claude session,
// so without agent access it installs perfectly and then does nothing useful. This checks the whole
// chain — runtime, package manager, git, dependencies, model access — and says exactly what to do
// about whatever is missing, before the first launch rather than after.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failed = 0;

/** One check line. `level`: ok | warn | fail — only `fail` makes the command exit non-zero. */
function report(level, label, detail, hint) {
  const mark =
    level === 'ok'
      ? `${GREEN}✓${RESET}`
      : level === 'warn'
        ? `${YELLOW}!${RESET}`
        : `${RED}✗${RESET}`;
  console.log(`  ${mark} ${label.padEnd(16)} ${detail}`);
  if (hint) console.log(`    ${DIM}${hint}${RESET}`);
  if (level === 'fail') failed += 1;
}

/** Run a command just to see whether it is there; returns its trimmed output or null. */
function probe(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32', // `pnpm`/`claude` are .cmd shims on Windows
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

console.log('\n  Alethic — preflight\n');

// ── runtime ────────────────────────────────────────────────────────────────
// Compared to the minor, not just the major: the floor is 22.13 because the pinned pnpm needs
// `node:sqlite`, and on 22.0–22.12 `pnpm install` dies before it installs anything — a
// major-only check would wave that through and let the failure surface as a stack trace instead.
const floor = (pkg.engines?.node ?? '>=22.13').replace(/[^\d.]/g, '');
const parse = (v) => v.split('.').map(Number);
const [needMajor, needMinor = 0] = parse(floor);
const [haveMajor, haveMinor] = parse(process.versions.node);
const nodeOk = haveMajor > needMajor || (haveMajor === needMajor && haveMinor >= needMinor);
report(
  nodeOk ? 'ok' : 'fail',
  'node',
  `v${process.versions.node} ${DIM}(need >= ${floor})${RESET}`,
  nodeOk ? null : 'Install a current Node LTS: https://nodejs.org',
);

// ── package manager ────────────────────────────────────────────────────────
const wanted = (pkg.packageManager ?? '').split('@')[1];
const pnpmVersion = probe('pnpm', ['--version']);
if (!pnpmVersion) {
  report(
    'fail',
    'pnpm',
    'not found',
    'Run `corepack enable` — it installs the pinned version for you.',
  );
} else if (wanted && pnpmVersion !== wanted) {
  report(
    'warn',
    'pnpm',
    `v${pnpmVersion} ${DIM}(repo pins ${wanted})${RESET}`,
    'Run `corepack enable` to match it.',
  );
} else {
  report('ok', 'pnpm', `v${pnpmVersion}`);
}

// ── git ────────────────────────────────────────────────────────────────────
// Not optional in practice: drift detection asks git what changed since the last sync, and the
// Git panel is one of the app's surfaces. Without it the map falls back to file mtimes.
const git = probe('git', ['--version']);
report(
  git ? 'ok' : 'warn',
  'git',
  git ? git.replace('git version ', 'v') : 'not found',
  git ? null : 'Drift detection falls back to file mtimes and the Git panel stays empty.',
);

// ── dependencies ───────────────────────────────────────────────────────────
const installed = existsSync(join(root, 'node_modules'));
report(
  installed ? 'ok' : 'fail',
  'dependencies',
  installed ? 'installed' : 'not installed',
  installed ? null : 'Run `pnpm install`.',
);

// ── model access ───────────────────────────────────────────────────────────
// The one that actually decides whether the app can do anything. Either route works: an API key in
// the environment, or a Claude Code login the SDK picks up on its own.
const apiKey = !!process.env['ANTHROPIC_API_KEY'];
const claudeCli = probe('claude', ['--version']);
if (apiKey) {
  report('ok', 'claude access', 'ANTHROPIC_API_KEY is set');
} else if (claudeCli) {
  report(
    'ok',
    'claude access',
    `Claude Code CLI ${DIM}(${claudeCli})${RESET}`,
    'If runs fail to start, re-authenticate with `claude auth login`.',
  );
} else {
  report(
    'fail',
    'claude access',
    'no API key and no Claude Code CLI',
    'Either `claude auth login` (https://claude.com/claude-code), or export ANTHROPIC_API_KEY.',
  );
}

// ── terminal backend (informational) ───────────────────────────────────────
// node-pty is an optional dependency with a piped-shell fallback, so its absence costs fidelity
// (no resize, no interactive prompts), never startup.
const hasPty = existsSync(join(root, 'apps', 'desktop', 'node_modules', 'node-pty'));
report(
  'ok',
  'terminal',
  hasPty ? 'node-pty' : `piped shell ${DIM}(node-pty not installed)${RESET}`,
  hasPty
    ? null
    : 'Optional. Without it the built-in terminal cannot resize or run interactive prompts.',
);

// ── known environment traps ────────────────────────────────────────────────
// A VS Code integrated terminal exports this, and the electron binary honours it: the app then
// starts as plain Node and dies on `does not provide an export named 'BrowserWindow'`.
if (process.env['ELECTRON_RUN_AS_NODE']) {
  report(
    'warn',
    'environment',
    'ELECTRON_RUN_AS_NODE is set',
    'Electron will start as plain Node and fail. Unset it, or launch from an external terminal.',
  );
}

console.log(
  failed === 0
    ? `\n  ${GREEN}Ready.${RESET} Start the app with ${DIM}pnpm dev${RESET}\n`
    : `\n  ${RED}${failed} check${failed === 1 ? '' : 's'} failed.${RESET} Fix the items above, then run ${DIM}pnpm doctor${RESET} again.\n`,
);
process.exit(failed === 0 ? 0 : 1);
