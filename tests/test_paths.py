"""Layout rules that other phases depend on."""

from __future__ import annotations

from pathlib import Path

from specrun import paths


def test_everything_specrun_writes_stays_under_one_folder() -> None:
    root = Path("/project")
    written = [
        paths.lock_path(root),
        paths.local_blueprints_dir(root),
        paths.map_path(root),
    ]
    for path in written:
        assert paths.project_dir(root) in path.parents

    # The exception, and the reason the emitter is a separate module: skills go where the agent
    # looks for them, not where Specrun keeps its own state.
    assert paths.claude_skills_dir(root) == root / ".claude" / "skills"
