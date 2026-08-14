"""The cycle phase 6 exists for: write a blueprint, sync, and the router offers it.

These go through `main` rather than through `install` directly, because the thing being checked is
the loop a developer actually performs — the commands, their exit codes, and what they print.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from specrun import index as index_module
from specrun.cli import main
from tests.conftest import write_index, write_local

ROUTER = ".claude/skills/blueprints/SKILL.md"
BUNDLED_COPY = ".claude/skills/blueprints/blueprints/rag-baseline.md"
LOCAL_COPY = ".claude/skills/blueprints/blueprints/house-style.md"

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

LOCAL_OVERRIDE = """
id = "rag-baseline"
title = "RAG baseline, our way"
use_when = "Answers must come from our own corpus"
"""


@pytest.fixture
def content(content_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A content root the commands will find, since they are not given one."""
    source = content_dir / "blueprints" / "blueprints" / "rag-baseline.md"
    source.write_text(
        '+++\nid = "rag-baseline"\ntitle = "RAG baseline"\nuse_when = "x"\n+++\n\nBody.\n',
        encoding="utf-8",
    )
    write_index(content_dir, BUNDLED)
    monkeypatch.setattr(index_module, "content_root", lambda: content_dir)
    return content_dir


def run(project: Path, *argv: str) -> int:
    return main(["--cwd", str(project), *argv])


def test_a_local_blueprint_reaches_the_router_after_sync(
    project: Path, content: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(project, "init") == 0
    assert "house-style" not in (project / ROUTER).read_text(encoding="utf-8")

    write_local(project, "house-style", LOCAL)
    assert run(project, "sync") == 0

    router = (project / ROUTER).read_text(encoding="utf-8")
    assert "House style" in router
    assert "Adding a new module to this repository" in router
    assert (project / LOCAL_COPY).is_file()

    capsys.readouterr()
    assert run(project, "status") == 0
    shown = capsys.readouterr().out
    assert "1 bundled, 1 local" in shown
    assert "house-style — local" in shown


def test_sync_does_not_need_init_to_have_looked_at_the_project_first(
    project: Path, content: Path
) -> None:
    # sync is the same compilation; it just does not ask what kind of project this is.
    assert run(project, "sync") == 0
    assert (project / ROUTER).is_file()


def test_sync_leaves_a_hand_edited_file_alone_and_says_so(
    project: Path, content: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run(project, "init")
    (project / BUNDLED_COPY).write_text("mine now\n", encoding="utf-8")
    capsys.readouterr()

    assert run(project, "sync") == 0

    assert (project / BUNDLED_COPY).read_text(encoding="utf-8") == "mine now\n"
    assert "edited by hand" in capsys.readouterr().out


def test_force_lets_sync_overwrite_a_hand_edited_file(project: Path, content: Path) -> None:
    run(project, "init")
    (project / BUNDLED_COPY).write_text("mine now\n", encoding="utf-8")

    assert run(project, "sync", "--force") == 0

    assert (project / BUNDLED_COPY).read_text(encoding="utf-8").endswith("Body.\n")


def test_removing_a_local_blueprint_takes_its_installed_copy_away(
    project: Path, content: Path
) -> None:
    write_local(project, "house-style", LOCAL)
    run(project, "init")
    assert (project / LOCAL_COPY).is_file()

    (project / ".specrun/local/blueprints/house-style.md").unlink()
    assert run(project, "sync") == 0

    # A copy nothing points at is a blueprint the agent can still open and no one maintains.
    assert not (project / LOCAL_COPY).exists()
    assert "house-style" not in (project / ROUTER).read_text(encoding="utf-8")


def test_shadowing_shows_up_in_both_sync_and_status(
    project: Path, content: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run(project, "init")
    write_local(project, "rag-baseline", LOCAL_OVERRIDE)
    capsys.readouterr()

    run(project, "sync")
    assert "overridden by local version" in capsys.readouterr().out

    run(project, "status")
    assert "rag-baseline — local, overriding the bundled version" in capsys.readouterr().out


def test_status_on_a_project_without_specrun_says_so(
    project: Path, content: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # Non-zero: a status that exits clean claims everything is where it should be.
    assert run(project, "status") == 1
    assert "specrun init" in capsys.readouterr().out


def test_json_output_is_machine_readable(
    project: Path, content: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    run(project, "init")
    write_local(project, "house-style", LOCAL)
    capsys.readouterr()

    assert run(project, "--json", "sync") == 0
    synced = json.loads(capsys.readouterr().out)
    assert synced["blueprints"] == {"bundled": 1, "local": 1}
    assert LOCAL_COPY in [f["path"] for f in synced["files"]]

    assert run(project, "--json", "status") == 0
    reported = json.loads(capsys.readouterr().out)
    assert reported["installed"] is True
    assert {b["id"] for b in reported["blueprints"]} == {"rag-baseline", "house-style"}
    assert all(f["state"] == "ok" for f in reported["files"])
