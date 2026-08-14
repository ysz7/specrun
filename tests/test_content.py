"""Finding the bundled content, and failing loudly when it is not there."""

from __future__ import annotations

from pathlib import Path

import pytest

from specrun import content, paths
from specrun.dev import reindex
from specrun.index import bundled_index_path, load_index
from tests.conftest import write_bundled

BLUEPRINT = """
id = "example"
title = "Example"
use_when = "Never; this blueprint exists only in a test"
pack = "test"
verified_at = 2026-08-01
stale_after = "90d"
"""


def test_the_repository_copy_is_found_from_a_source_checkout() -> None:
    # Editable installs resolve `import specrun` to the source tree, where the packaged copy does
    # not exist. Without this fallback every command would run against no blueprints at all.
    root = content.content_root()
    assert root.is_dir()
    assert root.name == paths.SKILLS_DIR_NAME


def test_missing_content_raises_instead_of_returning_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(paths, "PACKAGED_CONTENT_DIR", tmp_path / "absent")
    monkeypatch.setattr(content, "_repository_skills_dir", lambda: None)

    with pytest.raises(content.ContentNotFound) as error:
        content.content_root()
    # The message has to name both places, or the reader cannot tell which install is broken.
    assert "absent" in str(error.value)
    assert str(paths.PLUGIN_DIR) in str(error.value)


def test_reindex_writes_what_load_index_reads(content_dir: Path, project: Path) -> None:
    write_bundled(content_dir, "example", BLUEPRINT)

    written = reindex.render(reindex.build(content_dir, "9.9.9"))
    bundled_index_path(content_dir).write_text(written, encoding="utf-8")

    index = load_index(project, content_dir)
    blueprint = index.by_id("example")
    assert index.content_version == "9.9.9"
    assert blueprint.use_when.startswith("Never")
    assert blueprint.path.is_file()  # the recorded path resolves back to the file it came from


def test_reindex_refuses_two_blueprints_with_the_same_id(content_dir: Path) -> None:
    write_bundled(content_dir, "first", BLUEPRINT)
    write_bundled(content_dir, "second", BLUEPRINT)

    with pytest.raises(Exception, match="share the id"):
        reindex.build(content_dir, "0.1.0")


def test_check_mode_fails_when_the_committed_index_is_out_of_date(
    content_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # CI runs this against the real content: a header edited without regenerating the index has
    # to fail the build, because the router would keep offering the blueprint under the old text.
    monkeypatch.setattr(reindex, "content_root", lambda: content_dir)
    write_bundled(content_dir, "example", BLUEPRINT)
    bundled_index_path(content_dir).write_text('{"schema_version": 1}', encoding="utf-8")

    assert reindex.main(["--check"]) == 1
    assert reindex.main([]) == 0
    assert reindex.main(["--check"]) == 0


def test_optional_fields_are_omitted_rather_than_written_as_null(content_dir: Path) -> None:
    write_bundled(content_dir, "bare", 'id = "bare"\ntitle = "Bare"\nuse_when = "Only a trigger"')

    entry = reindex.build(content_dir, "0.1.0")["blueprints"][0]
    assert set(entry) == {"id", "path", "title", "use_when"}
