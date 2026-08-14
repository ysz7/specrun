// pnpm dogfood [-- <vitest args>]
//
// Phase 2 dog-food: runs the live harness (apps/desktop/src/main/services/dogfood.live.test.ts)
// against a real Claude session — a Claude Code login (`claude auth login`) or ANTHROPIC_API_KEY.
// It is deliberately NOT part of `pnpm test`: real model calls, minutes per scenario, real tokens.
//
//   pnpm dogfood                    all three scenarios
//   pnpm dogfood -- -t "plan mode"  one of them
//   ALETHIC_MODEL=claude-opus-5 pnpm dogfood
//   ALETHIC_DOGFOOD_KEEP=1 pnpm dogfood     keep the produced maps for inspection
import { execFileSync } from 'node:child_process';

// `pnpm dogfood -- -t "plan mode"`: drop pnpm's separator and re-quote args with spaces, since we
// spawn through a shell (npx needs one on Windows) and would otherwise split them.
const args = process.argv
  .slice(2)
  .filter((a) => a !== '--')
  .map((a) => (/\s/.test(a) ? `"${a}"` : a));
console.log('\n▶ dog-food — live agent runs, in temp directories only.\n');

try {
  execFileSync(
    'npx',
    [
      'vitest',
      'run',
      // The default reporter drops a passing test's console.log once stdout is not a TTY (e.g.
      // `pnpm dogfood > file.log`), so a redirected run records only pass/fail and none of the
      // evidence the harness prints as it goes. `verbose` keeps it regardless of where stdout
      // points.
      '--reporter=verbose',
      'apps/desktop/src/main/services/dogfood.live.test.ts',
      ...args,
    ],
    {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ALETHIC_DOGFOOD: '1' },
    },
  );
} catch {
  process.exit(1);
}
