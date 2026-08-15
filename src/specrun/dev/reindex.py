"""Rebuild the generated files in the content folder from the blueprint headers.

Run by hand before a release, and in CI to check that what is committed still matches the
blueprints:

    python -m specrun.dev.reindex
    python -m specrun.dev.reindex --check

Two files are generated. `index.json` is what the package reads at install time; it duplicates
every header field it lists, and anything duplicated by hand eventually disagrees with its source
— invisibly, here, since the router would go on offering a blueprint under a `use_when` the
blueprint itself no longer contains.

The router `SKILL.md` beside it is the marketplace's copy. A project that installs the CLI gets a
router compiled for it, listing its own local blueprints as well; a project that installs the
plugin from the marketplace has no build step at all and reads whatever is in git. So the bundled
blueprints need a router committed next to them, and it is produced by the same emitter that
writes the per-project one rather than maintained as a second, drifting copy.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from .. import __version__, paths
from ..content import content_root
from ..emit.claude import router
from ..frontmatter import BlueprintError, read
from ..index import SCHEMA_VERSION, Skill, bundled_blueprints_dir, bundled_index_path


def build(root: Path, content_version: str) -> dict[str, Any]:
    """The contents of index.json for the skills folder at `root`."""
    directory = bundled_blueprints_dir(root)
    index_dir = bundled_index_path(root).parent

    entries: list[dict[str, Any]] = []
    seen: dict[str, Path] = {}
    for path in sorted(directory.glob("*.md")):
        blueprint = read(path)
        if blueprint.id in seen:
            raise BlueprintError(
                f"two bundled blueprints share the id {blueprint.id!r}: "
                f"{seen[blueprint.id].name} and {path.name}"
            )
        seen[blueprint.id] = path

        entry: dict[str, Any] = {
            "id": blueprint.id,
            "path": path.relative_to(index_dir).as_posix(),
            "title": blueprint.title,
            "use_when": blueprint.use_when,
        }
        # Optional fields are omitted rather than written as null: an absent promise of freshness
        # reads differently from one that was made and left empty.
        if blueprint.pack:
            entry["pack"] = blueprint.pack
        if blueprint.verified_at:
            entry["verified_at"] = blueprint.verified_at.isoformat()
        if blueprint.stale_after:
            entry["stale_after"] = blueprint.stale_after
        entries.append(entry)

    return {
        "schema_version": SCHEMA_VERSION,
        # Content ships inside the package, so the two versions move together by construction.
        "content_version": content_version,
        "blueprints": entries,
        "skills": standalone_skills(root),
    }


def standalone_skills(root: Path) -> list[str]:
    """Skill folders that ship as they are, found rather than listed.

    The router skill is excluded: it is generated per project from the blueprints installed there,
    so copying the repository's copy of it would install a table describing someone else's project.
    Everything else with a `SKILL.md` is a skill in its own right and travels whole.
    """
    return sorted(
        directory.name
        for directory in root.iterdir()
        if directory.is_dir()
        and directory.name != paths.BLUEPRINTS_SKILL_NAME
        and (directory / paths.SKILL_FILE_NAME).is_file()
    )


def render(index: dict[str, Any]) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


def bundled_router(root: Path) -> str:
    """The router as the marketplace serves it: bundled blueprints only, no local ones.

    The standalone skills are passed by name and with no files, because the router only asks
    which of them are present — reading their contents here would be work thrown away.
    """
    blueprints = tuple(read(path) for path in sorted(bundled_blueprints_dir(root).glob("*.md")))
    skills = tuple(Skill(name=name, files={}) for name in standalone_skills(root))
    return router(blueprints, skills)


def generated(root: Path, content_version: str) -> dict[Path, str]:
    """Every file in the content folder that is produced rather than written, by path."""
    return {
        bundled_index_path(root): render(build(root, content_version)),
        bundled_index_path(root).parent / paths.SKILL_FILE_NAME: bundled_router(root),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m specrun.dev.reindex",
        description="Rebuild index.json from the bundled blueprint headers.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="do not write; fail if the committed index is out of date",
    )
    args = parser.parse_args(argv)

    root = content_root()
    try:
        files = generated(root, __version__)
    except BlueprintError as error:
        print(f"reindex: {error}", file=sys.stderr)
        return 1

    if args.check:
        stale = [
            target
            for target, rendered in files.items()
            if (target.read_text(encoding="utf-8") if target.is_file() else "") != rendered
        ]
        for target in stale:
            print(
                f"reindex: {target} is out of date; run `python -m specrun.dev.reindex`",
                file=sys.stderr,
            )
        if stale:
            return 1
        print(f"reindex: {len(files)} generated file(s) up to date in {root}")
        return 0

    for target, rendered in files.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered, encoding="utf-8")

    written = json.loads(files[bundled_index_path(root)])
    count, skills = len(written["blueprints"]), len(written["skills"])
    print(
        f"reindex: wrote {len(files)} file(s) in {root} "
        f"({count} blueprint{'s' if count != 1 else ''}, "
        f"{skills} standalone skill{'s' if skills != 1 else ''})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
