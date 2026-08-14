"""Rebuild `index.json` from the blueprint headers.

Run by hand before a release, and in CI to check that the committed index still matches the
blueprints:

    python -m specrun.dev.reindex
    python -m specrun.dev.reindex --check

The index is generated rather than maintained because it duplicates every header field it lists.
Anything duplicated by hand eventually disagrees with its source, and here the disagreement would
be invisible: the router would go on offering a blueprint under a `use_when` that the blueprint
itself no longer contains.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from .. import __version__
from ..content import content_root
from ..frontmatter import BlueprintError, read
from ..index import SCHEMA_VERSION, bundled_blueprints_dir, bundled_index_path


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
        "skills": [],
    }


def render(index: dict[str, Any]) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


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
    target = bundled_index_path(root)
    try:
        rendered = render(build(root, __version__))
    except BlueprintError as error:
        print(f"reindex: {error}", file=sys.stderr)
        return 1

    if args.check:
        current = target.read_text(encoding="utf-8") if target.is_file() else ""
        if current != rendered:
            print(
                f"reindex: {target} is out of date; run `python -m specrun.dev.reindex`",
                file=sys.stderr,
            )
            return 1
        print(f"reindex: {target} is up to date")
        return 0

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered, encoding="utf-8")
    count = len(json.loads(rendered)["blueprints"])
    print(f"reindex: wrote {target} ({count} blueprint{'s' if count != 1 else ''})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
