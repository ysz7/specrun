"""Command line entry point.

Five commands and no more: `init`, `sync`, `status`, `scan`, and `--version`. The command set is
deliberately small — anything an agent can do in chat does not need a command here, and the CLI
never calls a model.

At this stage every subcommand is a stub: it names itself and exits non-zero. A stub that exited
zero would report success to a script that then found no files.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from . import __version__

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
    subcommands.add_parser("init", help="install blueprints and skills into this project")
    subcommands.add_parser("sync", help="regenerate what init installed, keeping manual edits")
    subcommands.add_parser("status", help="what is installed, what is stale, what was edited")
    subcommands.add_parser("scan", help="read facts about this repository")
    return parser


def _not_implemented(command: str) -> int:
    print(f"specrun {command}: not implemented", file=sys.stderr)
    return 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    # Built now because a wrong --cwd should fail here, once, rather than inside each command.
    Context(root=Path(args.cwd).resolve(), quiet=args.quiet, json=args.json)

    return _not_implemented(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
