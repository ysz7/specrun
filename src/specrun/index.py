"""The index: what blueprints exist, where they came from, and which ones displaced which.

Two sources feed it. The blueprints that ship with the package are read from `index.json`, which
is generated from their headers at release time — reading a prebuilt list is why the router does
not have to open a dozen files to answer one question. The blueprints a project wrote for itself
live in `.specrun/local/blueprints/` and are read from disk every time, because nothing generates
an index for them and nothing should: they change as the project changes.

Where the two collide on an `id`, the local one wins. That is the point of local blueprints —
a project that disagreed with a bundled blueprint said so, and its answer is the current one.
The bundled blueprint is not deleted or edited, it is shadowed, and the shadowing is recorded
here so that `status` can show it. A local blueprint that silently replaced a bundled one would
leave the author of the project unable to explain why the agent stopped following the original.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Mapping

from . import paths
from .content import content_root
from .frontmatter import Blueprint, BlueprintError, read

#: Bumped when the shape of index.json changes in a way older readers cannot handle.
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Skill:
    """A skill that ships whole, as opposed to a blueprint the router offers.

    Blueprints are content the router chooses between; a skill like `blueprint-author` is a tool
    that stands on its own description and is installed beside the router, not listed by it. Its
    files are carried here as text rather than as a path so that an emitter stays a function of
    the content it is given and never reads the disk itself.
    """

    name: str
    #: Path relative to the skill's own folder → contents. `SKILL.md`, plus whatever it ships with.
    files: Mapping[str, str]


@dataclass(frozen=True)
class Shadowing:
    """A local blueprint that took the place of a bundled one with the same id."""

    id: str
    bundled_path: Path
    local_path: Path


@dataclass(frozen=True)
class Index:
    """Everything available to the router, and how it got that way."""

    content_version: str
    blueprints: tuple[Blueprint, ...] = ()
    #: Standalone skills that ship alongside the router, installed as they are.
    skills: tuple[Skill, ...] = ()
    shadowed: tuple[Shadowing, ...] = ()
    #: Local files that could not be read. Kept rather than raised: one malformed blueprint in a
    #: project's own folder should not make every command fail, but it must not vanish either.
    problems: tuple[str, ...] = ()
    schema_version: int = SCHEMA_VERSION

    def by_id(self, blueprint_id: str) -> Blueprint | None:
        return next((b for b in self.blueprints if b.id == blueprint_id), None)

    @property
    def bundled(self) -> tuple[Blueprint, ...]:
        return tuple(b for b in self.blueprints if not b.is_local)

    @property
    def local(self) -> tuple[Blueprint, ...]:
        return tuple(b for b in self.blueprints if b.is_local)

    def stale(self, today: date | None = None) -> tuple[Blueprint, ...]:
        moment = today or date.today()
        return tuple(b for b in self.blueprints if b.stale_on(moment))


def load_index(project_root: Path, content_dir: Path | None = None) -> Index:
    """The blueprints available to `project_root`: bundled, plus local, local winning ties."""
    root = content_dir or content_root()
    content_version, bundled, skills = read_bundled(root)
    local, problems = read_local(project_root)

    by_id: dict[str, Blueprint] = {b.id: b for b in bundled}
    shadowed: list[Shadowing] = []

    for blueprint in local:
        displaced = by_id.get(blueprint.id)
        if displaced is not None:
            shadowed.append(
                Shadowing(id=blueprint.id, bundled_path=displaced.path, local_path=blueprint.path)
            )
            blueprint = replace(blueprint, shadows=displaced.id)
        by_id[blueprint.id] = blueprint

    return Index(
        content_version=content_version,
        blueprints=tuple(sorted(by_id.values(), key=lambda b: b.id)),
        skills=skills,
        shadowed=tuple(shadowed),
        problems=tuple(problems),
    )


def read_bundled(root: Path) -> tuple[str, tuple[Blueprint, ...], tuple[Skill, ...]]:
    """Read the generated index that ships with the package."""
    index_path = bundled_index_path(root)
    if not index_path.is_file():
        raise FileNotFoundError(
            f"{index_path} is missing. It is generated from the blueprint headers by "
            "`python -m specrun.dev.reindex` and committed; it is not written by hand."
        )

    data = json.loads(index_path.read_text(encoding="utf-8"))
    schema_version = data.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        raise ValueError(
            f"{index_path} has schema_version {schema_version!r}, but this version of Specrun "
            f"reads {SCHEMA_VERSION}. Upgrade specrun, or regenerate the index."
        )

    blueprints = tuple(
        _blueprint_from_entry(entry, index_path.parent) for entry in data.get("blueprints", ())
    )
    skills = tuple(read_skill(root, str(name)) for name in data.get("skills", ()))
    return str(data.get("content_version", "")), blueprints, skills


def read_skill(root: Path, name: str) -> Skill:
    """Read one standalone skill folder out of the content at `root`.

    Everything under the folder travels, not just `SKILL.md`: a skill that ships a template or a
    licence file is broken by a copy that takes only its manifest. Files are read as text because
    every file a skill carries is text — a binary asset would have to be handled here, and there
    is no reason for a skill to grow one.
    """
    directory = root / name
    manifest = directory / paths.SKILL_FILE_NAME
    if not manifest.is_file():
        raise FileNotFoundError(
            f"{manifest} is missing, but {bundled_index_path(root)} lists {name!r} as a skill. "
            "Either the skill folder was not packaged, or the index is out of date; "
            "`python -m specrun.dev.reindex` rebuilds it."
        )

    files = {
        path.relative_to(directory).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }
    return Skill(name=name, files=files)


def read_local(project_root: Path) -> tuple[tuple[Blueprint, ...], tuple[str, ...]]:
    """Read the project's own blueprints. Missing folder means none, which is the normal case."""
    directory = paths.local_blueprints_dir(project_root)
    if not directory.is_dir():
        return (), ()

    blueprints: list[Blueprint] = []
    problems: list[str] = []
    for path in sorted(directory.glob("*.md")):
        try:
            blueprints.append(read(path, origin="local"))
        except (BlueprintError, OSError, UnicodeDecodeError) as error:
            problems.append(str(error))
    return tuple(blueprints), tuple(problems)


def bundled_index_path(root: Path) -> Path:
    """`index.json` inside the router skill, next to the blueprints it lists."""
    return root / paths.BLUEPRINTS_SKILL_NAME / paths.INDEX_FILE_NAME


def bundled_blueprints_dir(root: Path) -> Path:
    """The folder the bundled blueprints themselves live in."""
    return root / paths.BLUEPRINTS_SKILL_NAME / paths.BLUEPRINTS_DIR_NAME


def _blueprint_from_entry(entry: dict[str, object], index_dir: Path) -> Blueprint:
    """One record of index.json back into a Blueprint.

    Paths in the file are relative to the folder holding it, so the content stays relocatable:
    the same folder is read from the repository, from a wheel, and from a project's `.claude/`.
    """
    verified_at = entry.get("verified_at")
    return Blueprint(
        id=str(entry["id"]),
        title=str(entry["title"]),
        use_when=str(entry["use_when"]),
        path=index_dir / str(entry["path"]),
        origin="bundled",
        pack=_optional(entry.get("pack")),
        verified_at=date.fromisoformat(str(verified_at)) if verified_at else None,
        stale_after=_optional(entry.get("stale_after")),
    )


def _optional(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
