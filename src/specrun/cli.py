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
from typing import Iterator, Sequence

from . import __version__
from .content import ContentNotFound
from .detect import Project, detect
from .index import Index, load_index
from .install import Outcome, Report, install
from .scan import DEFAULT_DEPTH, Scan, TreeNode, scan
from .status import FileState, Status, status

COMMANDS = ("init", "sync", "status", "scan")


class CommandError(Exception):
    """Something the developer has to fix before the command can do its job.

    Carries its own exit code so that a command reads as a straight line of work rather than as a
    chain of `if isinstance(result, int)` checks around every step that might fail.
    """

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


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
    _add_global_flags(parser)

    subcommands = parser.add_subparsers(dest="command", metavar="COMMAND")
    init = subcommands.add_parser(
        "init", help="install blueprints and skills into this project"
    )
    init.add_argument(
        "--force",
        action="store_true",
        help="overwrite files that were edited by hand",
    )
    sync = subcommands.add_parser(
        "sync", help="regenerate what init installed, keeping manual edits"
    )
    sync.add_argument(
        "--force",
        action="store_true",
        help="overwrite files that were edited by hand",
    )
    subcommands.add_parser("status", help="what is installed, what is stale, what was edited")
    scan = subcommands.add_parser("scan", help="read facts about this repository")
    scan.add_argument(
        "--depth",
        type=int,
        default=DEFAULT_DEPTH,
        metavar="N",
        help=f"how deep the reported directory tree goes (default: {DEFAULT_DEPTH})",
    )

    # `specrun scan --json` is how anyone would write it, and how the map skill is documented to
    # call it, so the global flags are accepted on either side of the command name.
    for subcommand in (init, sync, subcommands.choices["status"], scan):
        _add_global_flags(subcommand, after_command=True)

    return parser


def _add_global_flags(parser: argparse.ArgumentParser, after_command: bool = False) -> None:
    """The flags every command takes. Repeated on each subcommand so word order does not matter.

    On a subcommand they default to SUPPRESS rather than to a value: an unused flag then leaves
    the namespace untouched, and whatever was given before the command name survives.
    """
    root_default = argparse.SUPPRESS if after_command else "."
    flag_default = argparse.SUPPRESS if after_command else False

    parser.add_argument(
        "--cwd",
        metavar="PATH",
        default=root_default,
        help="project to act on (default: the current directory)",
    )
    parser.add_argument(
        "--quiet", action="store_true", default=flag_default, help="only report problems"
    )
    parser.add_argument(
        "--json", action="store_true", default=flag_default, help="machine-readable output"
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    context = Context(root=Path(args.cwd).resolve(), quiet=args.quiet, json=args.json)

    try:
        if args.command == "init":
            return cmd_init(context, force=args.force)
        if args.command == "sync":
            return cmd_sync(context, force=args.force)
        if args.command == "status":
            return cmd_status(context)
        if args.command == "scan":
            return cmd_scan(context, depth=args.depth)
    except CommandError as error:
        print(f"specrun {args.command}: {error}", file=sys.stderr)
        return error.code
    return _not_implemented(args.command)


def cmd_init(context: Context, force: bool = False) -> int:
    """Look at the project, compile the content into it, and say what happened."""
    _require_directory(context.root)
    project = detect(context.root)
    index = _load_index(context.root)

    report = install(context.root, index, specrun_version=__version__, force=force)

    if context.json:
        print(json.dumps(_compilation_json(index, report, project), indent=2))
    else:
        _print_compilation(index, report, context.quiet, project)

    return 0


def cmd_sync(context: Context, force: bool = False) -> int:
    """Compile the content into the project again — the same work as `init`, minus the looking.

    `init` asks what kind of project this is because it is meeting it for the first time. `sync`
    already knows, and is here for the two moments when the answer has moved: the package was
    upgraded, or the project wrote a blueprint of its own. Both are the same job — read everything
    again, regenerate, and leave hand-edited files alone.
    """
    _require_directory(context.root)
    index = _load_index(context.root)

    report = install(context.root, index, specrun_version=__version__, force=force)

    if context.json:
        print(json.dumps(_compilation_json(index, report), indent=2))
    else:
        _print_compilation(index, report, context.quiet)

    return 0


def _compilation_json(index: Index, report: Report, project: Project | None = None) -> dict:
    data: dict = {
        "specrun_version": __version__,
        "content_version": index.content_version,
        "blueprints": {"bundled": len(index.bundled), "local": len(index.local)},
        "shadowed": [s.id for s in index.shadowed],
        "problems": list(index.problems),
        **report.to_dict(),
    }
    if project is not None:
        data["project"] = {
            "root": str(project.root),
            "stacks": list(project.stacks),
            "has_tests": project.has_tests,
            "has_agent_dir": project.has_agent_dir,
        }
    return data


def _print_compilation(
    index: Index, report: Report, quiet: bool, project: Project | None = None
) -> None:
    """The summary `init` and `sync` share, since they did the same work.

    Only the opening differs: `init` says what it found the project to be, because that is the
    question it just answered and the one a first-time reader wants confirmed.
    """
    edited = report.edited_by_hand

    if not quiet:
        print(f"specrun {__version__} · content {index.content_version}")
        if project is not None:
            described = ", ".join(
                filter(None, [project.stack, "tests" if project.has_tests else ""])
            )
            print(f"project: {project.root} ({described})")
        print(f"target: {report.target}")
        print()
        print(f"blueprints: {len(index.bundled)} bundled, {len(index.local)} local")
        for shadowing in index.shadowed:
            print(f"  · {shadowing.id} — overridden by local version")
        print()
        for result in report.files:
            if result.outcome is not Outcome.KEPT:
                print(f"  {result.outcome.value:<11} {result.path}")
        if not report.changed and not edited:
            print("  everything already up to date")

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


def cmd_status(context: Context) -> int:
    """Report what is installed here without changing any of it."""
    _require_directory(context.root)

    # An unreadable content root is worth reporting rather than dying on: the file list comes from
    # the lock and is exactly what someone diagnosing a broken install needs to see.
    try:
        index: Index | None = load_index(context.root)
    except (ContentNotFound, FileNotFoundError, ValueError) as error:
        index = None
        content_problem: str | None = str(error)
    else:
        content_problem = None

    report = status(context.root, index)

    if context.json:
        data = report.to_dict()
        if content_problem:
            data["problems"] = [*data["problems"], content_problem]
        print(json.dumps(data, indent=2))
        return 0

    _print_status(report, content_problem, context.quiet)
    return 0 if report.installed else 1


def _print_status(report: Status, content_problem: str | None, quiet: bool) -> None:
    if not report.installed:
        print("specrun is not installed in this project. Run `specrun init` to install it.")
        if content_problem:
            print(f"  problem     {content_problem}", file=sys.stderr)
        return

    if not quiet:
        print(f"specrun {report.specrun_version} · content {report.content_version}")
        print(f"target: {', '.join(report.targets) or 'none recorded'}")
        if report.content_is_behind:
            print(
                f"content {report.available_content_version} is available — run `specrun sync`"
            )
        print()
        print(f"blueprints: {len(report.bundled)} bundled, {len(report.local)} local")

    for blueprint in report.blueprints:
        # A bundled blueprint with nothing wrong with it is already covered by the count above.
        # Everything a project cannot see from the package alone — its own blueprints, the ones
        # they displaced, and anything past its own freshness deadline — gets a line of its own.
        notes = []
        if blueprint.shadows:
            notes.append("local, overriding the bundled version")
        elif blueprint.origin == "local":
            notes.append("local")
        if blueprint.stale:
            notes.append(
                f"stale (verified_at {blueprint.verified_at}, "
                f"stale_after {blueprint.stale_after})"
            )
        if notes:
            print(f"  {'!' if blueprint.stale else '·'} {blueprint.id} — {'; '.join(notes)}")

    edited = report.of(FileState.EDITED)
    missing = report.of(FileState.MISSING)

    if not quiet:
        print()
        counted = ", ".join(
            filter(
                None,
                [
                    f"{len(report.files)}",
                    f"{len(edited)} edited manually" if edited else "",
                    f"{len(missing)} missing" if missing else "",
                ],
            )
        )
        print(f"files: {counted}")

    for file in edited:
        print(f"  ~ {file.path}")
    for file in missing:
        print(f"  ? {file.path} — gone; `specrun sync` writes it again")

    for problem in report.problems:
        print(f"  problem     {problem}", file=sys.stderr)
    if content_problem:
        print(f"  problem     {content_problem}", file=sys.stderr)


def cmd_scan(context: Context, depth: int = DEFAULT_DEPTH) -> int:
    """Read the repository and print what is in it.

    The map skill is the reason this command exists, and it reads `--json`. The text form is for
    the person checking what the skill will be given, so it shows the same facts in the order
    someone reading a repository for the first time would want them.
    """
    _require_directory(context.root)
    if depth < 1:
        raise CommandError("--depth must be at least 1", code=2)

    report = scan(context.root, depth=depth)

    if context.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        _print_scan(report, context.quiet)

    return 0


def _print_scan(report: Scan, quiet: bool) -> None:
    languages = ", ".join(f"{name} {count}" for name, count in report.languages)

    if not quiet:
        print(f"{report.name} · {report.root}")
        print(f"files: {report.file_count}" + (f" · {languages}" if languages else ""))

        if report.tree and report.tree.children:
            print()
            print("tree")
            for node, level in _tree_lines(report.tree):
                marker = " …" if node.truncated else ""
                if node.hidden_children:
                    marker += f" (+{node.hidden_children} more)"
                indent = "  " * level
                print(f"  {indent}{node.name}/ ({node.total_files}){marker}")

        if report.modules:
            print()
            print("modules")
            for module in report.modules:
                print(
                    f"  {module.name} ({module.path}) — "
                    f"{module.language}, {module.files} file(s)"
                )

        if report.imports:
            print()
            print("imports")
            for edge in report.imports:
                print(f"  {edge.source} → {edge.target} ({edge.count})")

        if report.entry_points:
            print()
            print("entry points")
            for entry in report.entry_points:
                print(f"  {entry.name} — {entry.path} [{entry.kind}]")

        if report.infrastructure:
            print()
            print("infrastructure")
            for item in report.infrastructure:
                print(f"  {item.kind:<22} {item.path}")

        if report.dependencies:
            print()
            print(f"dependencies: {len(report.dependencies)} in {', '.join(report.manifests)}")
            for dependency in report.dependencies:
                print(f"  {dependency.name} ({dependency.scope})")

    for note in report.notes:
        print(f"  note        {note}", file=sys.stderr)


def _tree_lines(node: TreeNode, level: int = 0) -> Iterator[tuple[TreeNode, int]]:
    """Depth-first walk of the reported tree, skipping the root's own line."""
    for child in node.children:
        yield child, level
        yield from _tree_lines(child, level + 1)


def _require_directory(root: Path) -> None:
    if not root.is_dir():
        raise CommandError(f"{root} is not a directory", code=2)


def _load_index(root: Path) -> Index:
    try:
        return load_index(root)
    except (ContentNotFound, FileNotFoundError, ValueError) as error:
        raise CommandError(str(error)) from error


def _not_implemented(command: str) -> int:
    print(f"specrun {command}: not implemented", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
