"""The emitter: contents only, never the disk."""

from __future__ import annotations

from pathlib import Path

from specrun.emit import claude
from specrun.frontmatter import parse
from tests.conftest import blueprint_file

BUNDLED = parse(
    blueprint_file('id = "rag-baseline"\ntitle = "RAG baseline"\nuse_when = "Documents"'),
    Path("rag-baseline.md"),
)
LOCAL = parse(
    blueprint_file('id = "house-style"\ntitle = "House style"\nuse_when = "New module"'),
    Path("house-style.md"),
    origin="local",
)


def test_the_router_offers_every_blueprint_with_the_line_that_selects_it() -> None:
    text = claude.router([BUNDLED, LOCAL])

    assert "| Blueprint | When it applies |" in text
    for blueprint in (BUNDLED, LOCAL):
        assert blueprint.title in text
        # use_when is the whole point of the table: without it the router has nothing to match on.
        assert blueprint.use_when in text
        assert f"blueprints/{blueprint.id}.md" in text


def test_the_router_carries_a_name_and_a_description() -> None:
    lines = claude.router([BUNDLED]).splitlines()

    assert lines[0] == "---"
    assert "name: blueprints" in lines
    assert any(line.startswith("description: ") and len(line) > 40 for line in lines)
    assert lines.index("---", 1) < 6  # frontmatter closes before the body starts


def test_the_description_names_the_blueprints_that_are_actually_installed() -> None:
    # The description is the whole triggering mechanism, so it must not advertise coverage this
    # installation does not have.
    text = claude.description([BUNDLED, LOCAL])
    assert "rag baseline" in text
    assert "house style" in text

    assert "rag baseline" not in claude.description([LOCAL])
    assert claude.description([]) != claude.description([BUNDLED])


def test_a_local_blueprint_is_marked_as_the_project_own() -> None:
    assert "*(local)*" in claude.router([BUNDLED, LOCAL])
    assert "*(local)*" not in claude.router([BUNDLED])


def test_emitting_writes_nothing(tmp_path: Path) -> None:
    source = tmp_path / "rag-baseline.md"
    source.write_text(blueprint_file('id = "rag-baseline"\ntitle = "T"\nuse_when = "W"'), "utf-8")
    blueprint = parse(source.read_text(encoding="utf-8"), source)

    files = claude.emit([blueprint])

    assert set(files) == {
        ".claude/skills/blueprints/SKILL.md",
        ".claude/skills/blueprints/blueprints/rag-baseline.md",
    }
    assert list(tmp_path.iterdir()) == [source]


def test_a_blueprint_is_copied_whole_header_included(tmp_path: Path) -> None:
    source = tmp_path / "rag-baseline.md"
    original = blueprint_file('id = "rag-baseline"\ntitle = "T"\nuse_when = "W"', "The body.")
    source.write_text(original, encoding="utf-8")

    files = claude.emit([parse(original, source)])

    # The header travels with the file: it is how the author skill later knows the blueprint's
    # id, when it was verified, and whether a local file was derived from it.
    assert files[".claude/skills/blueprints/blueprints/rag-baseline.md"] == original


def test_paths_are_relative_and_posix() -> None:
    for path in claude.emit([]).keys():
        assert not path.startswith("/")
        assert "\\" not in path
