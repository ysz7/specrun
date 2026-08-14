"""The lock: what Specrun wrote, and exactly what it wrote.

The lock exists to answer one question before overwriting anything — *is this file still the one
we produced?* If the hash on disk matches the hash recorded here, the file is ours and can be
regenerated. If it does not, someone edited it, and the edit wins: it is reported and left alone.
That is the whole ownership rule, and it is why the lock stores a hash per file rather than a
timestamp, which would call every checkout an edit.

A file that was skipped keeps its **old** recorded hash. Recording the edited hash instead would
quietly adopt the edit, and the next run would overwrite it as if Specrun had written it.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from . import paths

SCHEMA_VERSION = 1


def sha256(text: str) -> str:
    """Hash of a file's contents as text, encoded the way it is written."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LockedFile:
    path: str  # relative to the project root, POSIX
    sha256: str
    target: str


@dataclass
class Lock:
    specrun_version: str
    content_version: str
    targets: tuple[str, ...] = ()
    files: list[LockedFile] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION

    def get(self, path: str) -> LockedFile | None:
        return next((f for f in self.files if f.path == path), None)

    def to_json(self) -> str:
        return (
            json.dumps(
                {
                    "schema_version": self.schema_version,
                    "specrun_version": self.specrun_version,
                    "content_version": self.content_version,
                    "targets": list(self.targets),
                    "files": [
                        {"path": f.path, "sha256": f.sha256, "target": f.target}
                        for f in sorted(self.files, key=lambda f: f.path)
                    ],
                },
                indent=2,
            )
            + "\n"
        )


def read(root: Path) -> Lock | None:
    """The lock for the project at `root`, or None if Specrun has never run here."""
    path = paths.lock_path(root)
    if not path.is_file():
        return None

    data = json.loads(path.read_text(encoding="utf-8"))
    schema_version = data.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        raise ValueError(
            f"{path} has schema_version {schema_version!r}, which this version of Specrun cannot "
            f"read (it understands {SCHEMA_VERSION}). Upgrade specrun, or delete the file to "
            "start again — deleting it makes every installed file look hand-edited, which is the "
            "safe direction."
        )

    return Lock(
        specrun_version=str(data.get("specrun_version", "")),
        content_version=str(data.get("content_version", "")),
        targets=tuple(data.get("targets", ())),
        files=[
            LockedFile(path=str(f["path"]), sha256=str(f["sha256"]), target=str(f["target"]))
            for f in data.get("files", ())
        ],
    )


def write(root: Path, lock: Lock) -> Path:
    """Write the lock, creating `.specrun/` if this is the first run."""
    path = paths.lock_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(lock.to_json(), encoding="utf-8")
    return path
