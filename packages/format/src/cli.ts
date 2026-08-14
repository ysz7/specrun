#!/usr/bin/env node
// alethic-format — the format CLI. The gate that runs in CI and in fixture tests.
//   alethic-format validate <dir>   validate a .alethic/ directory
import { validateDir } from './validate.js';

function usage(): never {
  process.stderr.write('usage: alethic-format validate <.alethic dir>\n');
  process.exit(2);
}

function main(argv: string[]): void {
  const [command, target] = argv;
  if (command !== 'validate' || !target) usage();

  const result = validateDir(target);
  for (const issue of result.issues) {
    const tag = issue.level === 'error' ? 'ERROR' : 'warn ';
    process.stdout.write(
      `${tag} ${issue.code}  ${issue.path}${issue.id ? ` [${issue.id}]` : ''}\n       ${issue.message}\n`,
    );
  }
  process.stdout.write(`\n${result.errors} error(s), ${result.warnings} warning(s)\n`);
  process.exit(result.ok ? 0 : 1);
}

main(process.argv.slice(2));
