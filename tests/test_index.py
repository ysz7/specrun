"""Merging what ships with the package and what the project wrote for itself."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from specrun.index import SCHEMA_VERSION, load_index
from tests.conftest import write_index, write_local, write_skill

BUNDLED = [
    {
        "id": "rag-baseline",
        "path": "blueprints/rag-baseline.md",
        "title": "RAG baseline",
        "use_when": "Search over documents returns the wrong passages",
        "pack": "ai-agents",
        "verified_at": "2026-02-01",
        "stale_after": "90d",
    },
    {
        "id": "agent-testing",
        "path": "blueprints/agent-testing.md",
        "title": "Agent testing",
        "use_when": "An agent has to be tested without calling a model on every run",
    },
]

LOCAL_OVERRIDE = """
id = "agent-testing"
title = "Agent testing, our way"
use_when = "An agent has to be tested without calling a model on every run"
based_on = "agent-testing@0.1.0"
"""

LOCAL_NEW = """
id = "house-style"
title = "House style"
use_when = "Adding a new module to this repository"
"""


def test_bundled_blueprints_are_read_from_the_generated_index(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED)
    index = load_index(project, content_dir)

    assert [b.id for b in index.blueprints] == ["agent-testing", "rag-baseline"]
    assert index.content_version == "0.1.0"
    assert index.schema_version == SCHEMA_VERSION
    # Paths in the file are relative to it, so the same folder works from a repo or a wheel.
    assert index.by_id("rag-baseline").path == (
        content_dir / "blueprints" / "blueprints" / "rag-baseline.md"
    )


def test_a_project_with_no_local_blueprints_is_the_normal_case(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED)
    index = load_index(project, content_dir)
    assert len(index.bundled) == 2
    assert index.local == ()
    assert index.shadowed == ()


def test_local_blueprints_are_added_to_the_bundled_ones(content_dir: Path, project: Path) -> None:
    write_index(content_dir, BUNDLED)
    write_local(project, "house-style", LOCAL_NEW)

    index = load_index(project, content_dir)
    assert [b.id for b in index.blueprints] == ["agent-testing", "house-style", "rag-baseline"]
    assert index.by_id("house-style").is_local


def test_a_local_blueprint_wins_over_a_bundled_one_with_the_same_id(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED)
    local_path = write_local(project, "agent-testing", LOCAL_OVERRIDE)

    index = load_index(project, content_dir)
    winner = index.by_id("agent-testing")

    assert winner.title == "Agent testing, our way"
    assert winner.is_local
    assert winner.path == local_path
    # The bundled one is displaced, not duplicated: one id, one answer.
    assert [b.id for b in index.blueprints].count("agent-testing") == 1


def test_the_shadowing_is_recorded_rather_than_happening_quietly(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED)
    local_path = write_local(project, "agent-testing", LOCAL_OVERRIDE)

    index = load_index(project, content_dir)

    assert len(index.shadowed) == 1
    shadowing = index.shadowed[0]
    assert shadowing.id == "agent-testing"
    assert shadowing.local_path == local_path
    assert shadowing.bundled_path.name == "agent-testing.md"
    # Also visible from the blueprint itself, so a caller holding one record can tell.
    assert index.by_id("agent-testing").shadows == "agent-testing"
    assert index.by_id("rag-baseline").shadows is None


def test_a_broken_local_blueprint_is_reported_instead_of_stopping_everything(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED)
    write_local(project, "good", LOCAL_NEW)
    (project / ".specrun" / "local" / "blueprints" / "broken.md").write_text(
        "no header here", encoding="utf-8"
    )

    index = load_index(project, content_dir)

    assert index.by_id("house-style") is not None
    assert len(index.problems) == 1
    assert "broken.md" in index.problems[0]


def test_staleness_uses_each_blueprint_own_promise(content_dir: Path, project: Path) -> None:
    write_index(content_dir, BUNDLED)
    index = load_index(project, content_dir)

    stale = index.stale(date(2026, 8, 14))
    assert [b.id for b in stale] == ["rag-baseline"]  # verified 2026-02-01, good for 90d


def test_a_blueprint_that_promised_no_freshness_never_goes_stale(
    content_dir: Path, project: Path
) -> None:
    # The three fields in LOCAL_NEW are everything a project has to write, and the README says so.
    # Treating the silence about `verified_at` as an expired promise would greet every first local
    # blueprint with a staleness warning about a date its author never wrote.
    write_index(content_dir, BUNDLED)
    write_local(project, "house-style", LOCAL_NEW)

    index = load_index(project, content_dir)

    assert index.by_id("house-style") is not None
    assert "house-style" not in [b.id for b in index.stale(date(2099, 1, 1))]


def test_an_index_from_a_newer_specrun_is_refused_rather_than_misread(
    content_dir: Path, project: Path
) -> None:
    path = write_index(content_dir, BUNDLED)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["schema_version"] = SCHEMA_VERSION + 1
    path.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(ValueError, match="schema_version"):
        load_index(project, content_dir)


def test_a_missing_index_says_how_it_is_generated(content_dir: Path, project: Path) -> None:
    with pytest.raises(FileNotFoundError, match="reindex"):
        load_index(project, content_dir)


def test_a_standalone_skill_travels_with_every_file_it_ships(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED, skills=["blueprint-author"])
    write_skill(
        content_dir,
        "blueprint-author",
        {"SKILL.md": "---\nname: blueprint-author\n---\n", "assets/template.md": "hi\n"},
    )

    index = load_index(project, content_dir)

    (skill,) = index.skills
    assert skill.name == "blueprint-author"
    # A skill that ships a template and arrives without it is installed broken.
    assert sorted(skill.files) == ["SKILL.md", "assets/template.md"]


def test_a_skill_listed_but_not_packaged_is_an_error_not_an_empty_folder(
    content_dir: Path, project: Path
) -> None:
    write_index(content_dir, BUNDLED, skills=["blueprint-author"])

    with pytest.raises(FileNotFoundError, match="blueprint-author"):
        load_index(project, content_dir)
