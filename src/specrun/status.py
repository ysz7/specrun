"""What is installed in a project, and what about it wants attention.

This answers from two sources and writes nothing. The lock says what Specrun put here and the
hash it wrote; the index says what is available now. Everything `status` reports is the
difference between those two and the disk.

Deliberately, it does not regenerate the content to compare against. Doing so would merge two
different questions — *did someone edit this file* and *has the bundled content moved on* — into
one answer, and the second is already visible as a content version that no longer matches the
lock. Comparing only against the recorded hash keeps "edited by hand" meaning exactly that.

The one thing that has to be impossible to miss here is shadowing. A local blueprint that quietly
replaced a bundled one leaves the agent following instructions nobody in the project remembers
writing, and no amount of reading the router explains why.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import Enum
from pathlib import Path
from typing import Any

from . import lock as lockfile
from .index import Index


class FileState(str, Enum):
    #: On disk and still byte-for-byte what the lock recorded.
    OK = "ok"
    #: On disk and different: someone edited it, and `sync` will leave it alone.
    EDITED = "edited"
    #: In the lock but not on disk. `sync` writes it again.
    MISSING = "missing"


@dataclass(frozen=True)
class FileStatus:
    path: str
    state: FileState
    target: str

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "state": self.state.value, "target": self.target}


@dataclass(frozen=True)
class BlueprintStatus:
    id: str
    title: str
    origin: str
    stale: bool
    verified_at: date | None = None
    stale_after: str | None = None
    #: True on a local blueprint that displaced a bundled one with the same id.
    shadows: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "origin": self.origin,
            "stale": self.stale,
            "verified_at": self.verified_at.isoformat() if self.verified_at else None,
            "stale_after": self.stale_after,
            "shadows_bundled": self.shadows,
        }


@dataclass(frozen=True)
class Status:
    """Everything `specrun status` has to say, before anyone decides how to print it."""

    installed: bool
    #: Versions recorded in the lock — what produced what is on disk.
    specrun_version: str = ""
    content_version: str = ""
    #: The content version available now. Differs from the above after an upgrade without a sync.
    available_content_version: str = ""
    targets: tuple[str, ...] = ()
    blueprints: tuple[BlueprintStatus, ...] = ()
    #: Standalone skills the content installs beside the router, by name. Read from the index
    #: rather than from the lock: the lock records paths, and working out which skill a path
    #: belongs to would put the emitter's layout back into a module that has no business knowing
    #: it. A skill installed but no longer shipped shows up the way any other stale file does —
    #: as a line in `files`.
    skills: tuple[str, ...] = ()
    files: tuple[FileStatus, ...] = ()
    #: Local blueprints that could not be read, and anything else worth saying aloud.
    problems: tuple[str, ...] = ()

    def of(self, state: FileState) -> tuple[FileStatus, ...]:
        return tuple(f for f in self.files if f.state is state)

    @property
    def bundled(self) -> tuple[BlueprintStatus, ...]:
        return tuple(b for b in self.blueprints if b.origin != "local")

    @property
    def local(self) -> tuple[BlueprintStatus, ...]:
        return tuple(b for b in self.blueprints if b.origin == "local")

    @property
    def stale(self) -> tuple[BlueprintStatus, ...]:
        return tuple(b for b in self.blueprints if b.stale)

    @property
    def shadowed(self) -> tuple[BlueprintStatus, ...]:
        return tuple(b for b in self.blueprints if b.shadows)

    @property
    def content_is_behind(self) -> bool:
        """Whether the package carries content newer than what was installed."""
        return bool(
            self.installed
            and self.available_content_version
            and self.available_content_version != self.content_version
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "installed": self.installed,
            "specrun_version": self.specrun_version,
            "content_version": self.content_version,
            "available_content_version": self.available_content_version,
            "content_is_behind": self.content_is_behind,
            "targets": list(self.targets),
            "blueprints": [b.to_dict() for b in self.blueprints],
            "skills": list(self.skills),
            "files": [f.to_dict() for f in self.files],
            "problems": list(self.problems),
        }


def status(root: Path, index: Index | None, today: date | None = None) -> Status:
    """Read the lock and the index and say where the project stands.

    `index` is optional because the content can be unreadable — a botched install, a wheel without
    its content folder — and a `status` that refuses to run in that case withholds exactly the
    information needed to diagnose it. Without an index the file list is still reported.
    """
    moment = today or date.today()
    lock = lockfile.read(root)
    if lock is None:
        return Status(
            installed=False,
            available_content_version=index.content_version if index else "",
            problems=index.problems if index else (),
        )

    return Status(
        installed=True,
        specrun_version=lock.specrun_version,
        content_version=lock.content_version,
        available_content_version=index.content_version if index else "",
        targets=lock.targets,
        blueprints=_blueprints(index, moment),
        skills=tuple(skill.name for skill in index.skills) if index else (),
        files=tuple(_file_status(root, entry) for entry in sorted(lock.files, key=lambda f: f.path)),
        problems=index.problems if index else (),
    )


def _blueprints(index: Index | None, today: date) -> tuple[BlueprintStatus, ...]:
    if index is None:
        return ()
    return tuple(
        BlueprintStatus(
            id=blueprint.id,
            title=blueprint.title,
            origin=blueprint.origin,
            stale=blueprint.stale_on(today),
            verified_at=blueprint.verified_at,
            stale_after=blueprint.stale_after,
            shadows=blueprint.shadows is not None,
        )
        for blueprint in index.blueprints
    )


def _file_status(root: Path, entry: lockfile.LockedFile) -> FileStatus:
    path = root / entry.path
    if not path.is_file():
        return FileStatus(path=entry.path, state=FileState.MISSING, target=entry.target)

    try:
        current = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        # Unreadable is not the same as edited, but it is certainly not ours any more, and the
        # two call for the same thing from the developer: go and look at the file.
        return FileStatus(path=entry.path, state=FileState.EDITED, target=entry.target)

    state = FileState.OK if lockfile.sha256(current) == entry.sha256 else FileState.EDITED
    return FileStatus(path=entry.path, state=state, target=entry.target)
