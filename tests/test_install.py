"""The ownership rule: what may be overwritten, and what must not be."""

from __future__ import annotations

from pathlib import Path

import pytest

from specrun import lock as lockfile
from specrun import paths
from specrun.index import load_index
from specrun.install import Outcome, ensure_gitignore, install
from tests.conftest import write_index, write_local

BUNDLED = [
    {
        "id": "rag-baseline",
        "path": "blueprints/rag-baseline.md",
        "title": "RAG baseline",
        "use_when": "Answers must come from a corpus the model was not trained on",
    }
]

LOCAL = """
id = "house-style"
title = "House style"
use_when = "Adding a new module to this repository"
"""

ROUTER = ".claude/skills/blueprints/SKILL.md"
COPY = ".claude/skills/blueprints/blueprints/rag-baseline.md"


@pytest.fixture
def content(content_dir: Path) -> Path:
    """A content root with one bundled blueprint and an index that lists it."""
    source = content_dir / "blueprints" / "blueprints" / "rag-baseline.md"
    source.write_text(
        '+++\nid = "rag-baseline"\ntitle = "RAG baseline"\nuse_when = "x"\n+++\n\nBody.\n',
        encoding="utf-8",
    )
    write_index(content_dir, BUNDLED)
    return content_dir


def run(project: Path, content: Path, force: bool = False):
    return install(project, load_index(project, content), specrun_version="0.1.0", force=force)


def test_a_clean_project_gets_the_router_and_every_blueprint(project: Path, content: Path) -> None:
    report = run(project, content)

    assert sorted(report.of(Outcome.CREATED)) == [ROUTER, COPY]
    assert (project / ROUTER).is_file()
    assert (project / COPY).read_text(encoding="utf-8").endswith("Body.\n")


def test_running_twice_changes_nothing(project: Path, content: Path) -> None:
    run(project, content)
    before = (project / ROUTER).read_text(encoding="utf-8")

    report = run(project, content)

    assert report.of(Outcome.UNCHANGED) == [ROUTER, COPY]
    assert not report.changed
    assert (project / ROUTER).read_text(encoding="utf-8") == before


def test_a_file_edited_by_hand_is_left_alone_and_reported(project: Path, content: Path) -> None:
    run(project, content)
    (project / COPY).write_text("mine now\n", encoding="utf-8")

    report = run(project, content)

    assert report.edited_by_hand == [COPY]
    assert (project / COPY).read_text(encoding="utf-8") == "mine now\n"


def test_the_lock_keeps_the_hash_it_wrote_rather_than_adopting_the_edit(
    project: Path, content: Path
) -> None:
    run(project, content)
    original = lockfile.read(project).get(COPY).sha256
    (project / COPY).write_text("mine now\n", encoding="utf-8")

    run(project, content)

    # Adopting the edited hash would make the next run treat the edit as ours and overwrite it.
    assert lockfile.read(project).get(COPY).sha256 == original
    run(project, content)
    assert (project / COPY).read_text(encoding="utf-8") == "mine now\n"


def test_force_overwrites_an_edited_file(project: Path, content: Path) -> None:
    run(project, content)
    (project / COPY).write_text("mine now\n", encoding="utf-8")

    report = run(project, content, force=True)

    assert report.of(Outcome.OVERWRITTEN) == [COPY]
    assert (project / COPY).read_text(encoding="utf-8").endswith("Body.\n")


def test_a_file_that_was_already_there_is_not_claimed(project: Path, content: Path) -> None:
    # Never written by Specrun, so there is no recorded hash and no right to replace it.
    target = project / ROUTER
    target.parent.mkdir(parents=True)
    target.write_text("someone else's skill\n", encoding="utf-8")

    report = run(project, content)

    assert report.edited_by_hand == [ROUTER]
    assert target.read_text(encoding="utf-8") == "someone else's skill\n"
    assert lockfile.read(project).get(ROUTER) is None


def test_updated_content_replaces_a_file_we_still_own(project: Path, content: Path) -> None:
    run(project, content)
    source = content / "blueprints" / "blueprints" / "rag-baseline.md"
    source.write_text(source.read_text(encoding="utf-8") + "\nA new paragraph.\n", encoding="utf-8")

    report = run(project, content)

    assert report.of(Outcome.UPDATED) == [COPY]
    assert "A new paragraph." in (project / COPY).read_text(encoding="utf-8")


def test_local_blueprints_are_installed_alongside_bundled_ones(
    project: Path, content: Path
) -> None:
    write_local(project, "house-style", LOCAL)

    run(project, content)

    installed = project / ".claude/skills/blueprints/blueprints/house-style.md"
    assert installed.is_file()
    assert "house-style" in (project / ROUTER).read_text(encoding="utf-8")


def test_a_file_we_no_longer_generate_and_still_own_is_taken_away(
    project: Path, content: Path
) -> None:
    write_local(project, "house-style", LOCAL)
    run(project, content)
    installed = project / ".claude/skills/blueprints/blueprints/house-style.md"
    assert installed.is_file()

    paths.local_blueprints_dir(project).joinpath("house-style.md").unlink()
    report = run(project, content)

    relative = installed.relative_to(project).as_posix()
    assert report.of(Outcome.REMOVED) == [relative]
    assert not installed.exists()
    assert lockfile.read(project).get(relative) is None


def test_an_orphan_that_was_edited_is_left_where_it_is(project: Path, content: Path) -> None:
    write_local(project, "house-style", LOCAL)
    run(project, content)
    installed = project / ".claude/skills/blueprints/blueprints/house-style.md"
    installed.write_text("mine now\n", encoding="utf-8")

    paths.local_blueprints_dir(project).joinpath("house-style.md").unlink()
    report = run(project, content)

    # We have no claim on it any more, so it stays — and stops being ours to track.
    relative = installed.relative_to(project).as_posix()
    assert report.edited_by_hand == [relative]
    assert installed.read_text(encoding="utf-8") == "mine now\n"
    assert lockfile.read(project).get(relative) is None


def test_the_lock_records_every_file_and_the_versions_that_produced_it(
    project: Path, content: Path
) -> None:
    report = run(project, content)

    lock = lockfile.read(project)
    assert report.lock_path == paths.lock_path(project)
    assert lock.specrun_version == "0.1.0"
    assert lock.content_version == "0.1.0"
    assert lock.targets == ("claude",)
    assert sorted(f.path for f in lock.files) == [ROUTER, COPY]
    assert all(f.target == "claude" for f in lock.files)


def test_the_generated_map_is_ignored_but_the_lock_is_not(project: Path) -> None:
    assert ensure_gitignore(project) is True

    ignored = (project / ".gitignore").read_text(encoding="utf-8")
    assert f"{paths.PROJECT_DIR_NAME}/{paths.MAP_FILE_NAME}" in ignored
    # The lock and local blueprints are how a team shares one answer; ignoring them would make
    # every checkout look like a different installation.
    assert paths.LOCK_FILE_NAME not in ignored
    assert f"{paths.PROJECT_DIR_NAME}/{paths.LOCAL_DIR_NAME}" not in ignored


def test_gitignore_is_not_written_twice(project: Path) -> None:
    (project / ".gitignore").write_text("node_modules/\n", encoding="utf-8")

    assert ensure_gitignore(project) is True
    assert ensure_gitignore(project) is False
    assert (project / ".gitignore").read_text(encoding="utf-8").count("map.html") == 1
    assert "node_modules/" in (project / ".gitignore").read_text(encoding="utf-8")
