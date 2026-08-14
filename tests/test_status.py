"""What `status` reports: versions, staleness, shadowing, and files that moved."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from specrun import lock as lockfile
from specrun.index import load_index
from specrun.install import install
from specrun.status import FileState, status
from tests.conftest import write_index, write_local

ROUTER = ".claude/skills/blueprints/SKILL.md"
COPY = ".claude/skills/blueprints/blueprints/rag-baseline.md"

BUNDLED = [
    {
        "id": "rag-baseline",
        "path": "blueprints/rag-baseline.md",
        "title": "RAG baseline",
        "use_when": "Answers must come from a corpus the model was not trained on",
        "verified_at": "2026-02-01",
        "stale_after": "90d",
    }
]

LOCAL_OVERRIDE = """
id = "rag-baseline"
title = "RAG baseline, our way"
use_when = "Answers must come from our corpus"
"""

LOCAL_OWN = """
id = "house-style"
title = "House style"
use_when = "Adding a new module to this repository"
"""


@pytest.fixture
def content(content_dir: Path) -> Path:
    source = content_dir / "blueprints" / "blueprints" / "rag-baseline.md"
    source.write_text(
        '+++\nid = "rag-baseline"\ntitle = "RAG baseline"\nuse_when = "x"\n+++\n\nBody.\n',
        encoding="utf-8",
    )
    write_index(content_dir, BUNDLED)
    return content_dir


def installed(project: Path, content: Path):
    return install(project, load_index(project, content), specrun_version="0.1.0")


def read(project: Path, content: Path | None, today: date | None = None):
    index = load_index(project, content) if content else None
    return status(project, index, today=today)


def test_a_project_without_a_lock_is_reported_as_not_installed(
    project: Path, content: Path
) -> None:
    report = read(project, content)

    assert report.installed is False
    assert report.files == ()
    assert report.to_dict()["installed"] is False


def test_versions_and_target_come_from_the_lock(project: Path, content: Path) -> None:
    installed(project, content)

    report = read(project, content)

    assert report.installed is True
    assert report.specrun_version == "0.1.0"
    assert report.content_version == "0.1.0"
    assert report.targets == ("claude",)


def test_untouched_files_are_ok(project: Path, content: Path) -> None:
    installed(project, content)

    report = read(project, content)

    assert sorted(f.path for f in report.of(FileState.OK)) == sorted([ROUTER, COPY])
    assert report.of(FileState.EDITED) == ()


def test_an_edited_file_is_reported_as_edited(project: Path, content: Path) -> None:
    installed(project, content)
    (project / COPY).write_text("mine now\n", encoding="utf-8")

    report = read(project, content)

    assert [f.path for f in report.of(FileState.EDITED)] == [COPY]


def test_a_deleted_file_is_reported_as_missing(project: Path, content: Path) -> None:
    installed(project, content)
    (project / COPY).unlink()

    report = read(project, content)

    assert [f.path for f in report.of(FileState.MISSING)] == [COPY]


def test_a_blueprint_past_its_own_deadline_is_stale(project: Path, content: Path) -> None:
    installed(project, content)

    fresh = read(project, content, today=date(2026, 4, 1))
    expired = read(project, content, today=date(2026, 6, 1))

    assert fresh.stale == ()
    assert [b.id for b in expired.stale] == ["rag-baseline"]
    assert expired.stale[0].verified_at == date(2026, 2, 1)
    assert expired.stale[0].stale_after == "90d"


def test_shadowing_is_visible_rather_than_silent(project: Path, content: Path) -> None:
    # A local blueprint replacing a bundled one without saying so leaves the agent following
    # instructions nobody remembers writing.
    write_local(project, "rag-baseline", LOCAL_OVERRIDE)
    installed(project, content)

    report = read(project, content)

    assert [b.id for b in report.shadowed] == ["rag-baseline"]
    assert [b.id for b in report.local] == ["rag-baseline"]
    assert report.bundled == ()


def test_a_local_blueprint_that_shadows_nothing_is_not_marked(
    project: Path, content: Path
) -> None:
    write_local(project, "house-style", LOCAL_OWN)
    installed(project, content)

    report = read(project, content)

    assert report.shadowed == ()
    assert [b.id for b in report.local] == ["house-style"]
    assert [b.id for b in report.bundled] == ["rag-baseline"]


def test_content_newer_than_the_lock_is_flagged(project: Path, content: Path) -> None:
    installed(project, content)
    write_index(content, BUNDLED, version="0.2.0")

    report = read(project, content)

    assert report.content_is_behind is True
    assert report.available_content_version == "0.2.0"
    assert report.content_version == "0.1.0"


def test_matching_versions_are_not_flagged(project: Path, content: Path) -> None:
    installed(project, content)

    assert read(project, content).content_is_behind is False


def test_status_still_answers_when_the_content_is_unreadable(
    project: Path, content: Path
) -> None:
    # The file list comes from the lock, and it is exactly what someone diagnosing a broken
    # install needs to see.
    installed(project, content)

    report = read(project, None)

    assert report.installed is True
    assert sorted(f.path for f in report.files) == sorted([ROUTER, COPY])
    assert report.blueprints == ()


def test_status_writes_nothing(project: Path, content: Path) -> None:
    installed(project, content)
    before = lockfile.read(project).to_json()
    router = (project / ROUTER).read_text(encoding="utf-8")

    read(project, content)

    assert lockfile.read(project).to_json() == before
    assert (project / ROUTER).read_text(encoding="utf-8") == router
