"""Writing what an emitter produced, and deciding what may be written.

This is the only place that compares a file on disk with what Specrun believes it wrote. The
emitter decides contents; this decides ownership. Keeping the two apart is what makes it possible
to test the ownership rule without generating content, and to change the content without touching
the rule.

`init` and `sync` are the same operation seen from different sides — `init` looks at the project
first and reports what it found — so both end up here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from . import lock as lockfile
from . import paths
from .emit import DEFAULT_TARGET, EMITTERS
from .index import Index

#: Written into the project's .gitignore. Only genuinely disposable output goes here: the lock
#: and any local blueprints are worth committing, because they are how a team shares the same
#: answer to "what did we install, and what did we decide to write ourselves".
GITIGNORE_ENTRIES = (f"{paths.PROJECT_DIR_NAME}/{paths.MAP_FILE_NAME}",)
GITIGNORE_HEADER = "# Specrun"


class Outcome(str, Enum):
    CREATED = "created"
    UPDATED = "updated"
    UNCHANGED = "unchanged"
    #: Differs from what we recorded: someone edited it. Left alone and reported.
    KEPT = "kept"
    #: Was edited, and `--force` was passed.
    OVERWRITTEN = "overwritten"
    #: We wrote it once, the content no longer produces it, and it was still ours to delete.
    REMOVED = "removed"


@dataclass
class FileResult:
    path: str
    outcome: Outcome


@dataclass
class Report:
    target: str
    files: list[FileResult] = field(default_factory=list)
    gitignore_updated: bool = False
    lock_path: Path | None = None

    def of(self, outcome: Outcome) -> list[str]:
        return [f.path for f in self.files if f.outcome is outcome]

    @property
    def edited_by_hand(self) -> list[str]:
        return self.of(Outcome.KEPT)

    @property
    def changed(self) -> bool:
        """Whether anything on disk actually moved."""
        return any(
            f.outcome in (Outcome.CREATED, Outcome.UPDATED, Outcome.OVERWRITTEN, Outcome.REMOVED)
            for f in self.files
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "files": [{"path": f.path, "outcome": f.outcome.value} for f in self.files],
            "gitignore_updated": self.gitignore_updated,
            "lock": str(self.lock_path) if self.lock_path else None,
        }


def install(
    root: Path,
    index: Index,
    specrun_version: str,
    target: str = DEFAULT_TARGET,
    force: bool = False,
    update_gitignore: bool = True,
) -> Report:
    """Compile the index into `root`, respecting files that were edited by hand."""
    emit = EMITTERS[target]
    generated = emit(index.blueprints)

    previous = lockfile.read(root)
    report = Report(target=target)
    entries: list[lockfile.LockedFile] = []

    for relative, contents in sorted(generated.items()):
        destination = root / relative
        recorded = previous.get(relative) if previous else None
        outcome, kept_hash = _decide(destination, contents, recorded, force)

        if outcome is not Outcome.KEPT:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents, encoding="utf-8")

        report.files.append(FileResult(path=relative, outcome=outcome))
        digest = kept_hash if outcome is Outcome.KEPT else lockfile.sha256(contents)
        if digest is not None:
            entries.append(lockfile.LockedFile(path=relative, sha256=digest, target=target))

    _remove_orphans(root, generated, previous, target, report)

    if update_gitignore:
        report.gitignore_updated = ensure_gitignore(root)

    report.lock_path = lockfile.write(
        root,
        lockfile.Lock(
            specrun_version=specrun_version,
            content_version=index.content_version,
            targets=(target,),
            files=entries,
        ),
    )
    return report


def _remove_orphans(
    root: Path,
    generated: dict[str, str],
    previous: lockfile.Lock | None,
    target: str,
    report: Report,
) -> None:
    """Take away the files this content no longer produces.

    Delete a local blueprint and the router stops listing it, but its installed copy would sit
    next to the router forever — a blueprint the agent can still open and nothing points at. So a
    file we wrote, still own, and no longer generate is removed.

    A file that was edited after we wrote it is a different matter: we have no claim on it any
    more, so it is left where it is, reported, and dropped from the lock. From here on it belongs
    to whoever edited it.
    """
    if previous is None:
        return

    for recorded in previous.files:
        if recorded.path in generated or recorded.target != target:
            continue

        path = root / recorded.path
        if not path.is_file():
            continue

        if lockfile.sha256(path.read_text(encoding="utf-8")) == recorded.sha256:
            path.unlink()
            report.files.append(FileResult(path=recorded.path, outcome=Outcome.REMOVED))
        else:
            report.files.append(FileResult(path=recorded.path, outcome=Outcome.KEPT))


def _decide(
    destination: Path,
    contents: str,
    recorded: lockfile.LockedFile | None,
    force: bool,
) -> tuple[Outcome, str | None]:
    """What to do with one file, and which hash to record if it is left alone."""
    if not destination.exists():
        return Outcome.CREATED, None

    current = destination.read_text(encoding="utf-8")
    if current == contents:
        return Outcome.UNCHANGED, None

    ours = recorded is not None and lockfile.sha256(current) == recorded.sha256
    if ours:
        return Outcome.UPDATED, None
    if force:
        return Outcome.OVERWRITTEN, None

    # Either the file was edited after we wrote it, or it was already there and we never wrote
    # it at all. Both mean the same thing here: it is not ours to replace. The recorded hash is
    # carried forward unchanged, so the edit is not adopted as if we had produced it.
    return Outcome.KEPT, recorded.sha256 if recorded else None


def ensure_gitignore(root: Path) -> bool:
    """Add Specrun's generated artefacts to .gitignore. Returns whether the file changed."""
    path = root / ".gitignore"
    existing = path.read_text(encoding="utf-8") if path.is_file() else ""
    present = {line.strip() for line in existing.splitlines()}
    missing = [entry for entry in GITIGNORE_ENTRIES if entry not in present]
    if not missing:
        return False

    block = "" if not existing else ("\n" if existing.endswith("\n") else "\n\n")
    path.write_text(
        existing + block + GITIGNORE_HEADER + "\n" + "\n".join(missing) + "\n",
        encoding="utf-8",
    )
    return True
