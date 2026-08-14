"""Command line entry point.

Five commands and no more: `init`, `sync`, `status`, `scan`, and `--version`. The command set is
deliberately small — anything an agent can do in chat does not need a command here, and the CLI
never calls a model.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from . import __version__
from .content import ContentNotFound
from .detect import Project, detect
from .emit import DEFAULT_TARGET
from .index import Index, load_index
from .install import Outcome, Report, install

COMMANDS = ("init", "sync", "status", "scan")


@dataclass(frozen=True)
class Context:
    """What every command needs regardless of what it does."""

    root: Path
    quiet: bool
    json: bool


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="specrun",
        description="Blueprints and skills for the AI you already code with.",
    )
    parser.add_argument("--version", action="version", version=f"specrun {__version__}")
    parser.add_argument(
        "--cwd",
        metavar="PATH",
        default=".",
        help="project to act on (default: the current directory)",
    )
    parser.add_argument("--quiet", action="store_true", help="only report problems")
    parser.add_argument("--json", action="store_true", help="machine-readable output")

    subcommands = parser.add_subparsers(dest="command", metavar="COMMAND")
    init = subcommands.add_parser(
        "init", help="install blueprints and skills into this project"
    )
    init.add_argument(
        "--force",
        action="store_true",
        help="overwrite files that were edited by hand",
    )
    subcommands.add_parser("sync", help="regenerate what init installed, keeping manual edits")
    subcommands.add_parser("status", help="what is installed, what is stale, what was edited")
    subcommands.add_parser("scan", help="read facts about this repository")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    context = Context(root=Path(args.cwd).resolve(), quiet=args.quiet, json=args.json)

    if args.command == "init":
        return cmd_init(context, force=args.force)
    return _not_implemented(args.command)


def cmd_init(context: Context, force: bool = False) -> int:
    """Look at the project, compile the content into it, and say what happened."""
    if not context.root.is_dir():
        print(f"specrun: {context.root} is not a directory", file=sys.stderr)
        return 2

    project = detect(context.root)
    try:
        index = load_index(context.root)
    except (ContentNotFound, FileNotFoundError, ValueError) as error:
        print(f"specrun init: {error}", file=sys.stderr)
        return 1

    report = install(context.root, index, specrun_version=__version__, force=force)

    if context.json:
        print(
            json.dumps(
                {
                    "specrun_version": __version__,
                    "content_version": index.content_version,
                    "project": {
                        "root": str(project.root),
                        "stacks": list(project.stacks),
                        "has_tests": project.has_tests,
                        "has_agent_dir": project.has_agent_dir,
                    },
                    "blueprints": {
                        "bundled": len(index.bundled),
                        "local": len(index.local),
                    },
                    **report.to_dict(),
                },
                indent=2,
            )
        )
    else:
        _print_init_summary(project, index, report, context.quiet)

    return 0


def _print_init_summary(project: Project, index: Index, report: Report, quiet: bool) -> None:
    edited = report.edited_by_hand

    if not quiet:
        described = ", ".join(filter(None, [project.stack, "tests" if project.has_tests else ""]))
        print(f"specrun {__version__} · content {index.content_version}")
        print(f"project: {project.root} ({described})")
        print(f"target: {DEFAULT_TARGET}")
        print()
        print(f"blueprints: {len(index.bundled)} bundled, {len(index.local)} local")
        for shadowing in index.shadowed:
            print(f"  · {shadowing.id} — overridden by local version")
        print()
        for result in report.files:
            if result.outcome is not Outcome.KEPT:
                print(f"  {result.outcome.value:<11} {result.path}")

    for path in edited:
        # Printed even under --quiet: this is the one outcome the developer has to act on.
        print(f"  {'kept':<11} {path} — edited by hand, left alone")

    for problem in index.problems:
        print(f"  {'problem':<11} {problem}", file=sys.stderr)

    if not quiet:
        print()
        if report.lock_path:
            print(f"lock: {report.lock_path}")
        if report.gitignore_updated:
            print("updated .gitignore")
        if edited:
            print(f"{len(edited)} file(s) left alone. Pass --force to overwrite them.")


def _not_implemented(command: str) -> int:
    print(f"specrun {command}: not implemented", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
