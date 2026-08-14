"""Builders for the two file layouts the index is read from."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from specrun import paths
from specrun.index import SCHEMA_VERSION


def blueprint_file(header: str, body: str = "Do the thing.") -> str:
    return f"+++\n{header.strip()}\n+++\n\n{body}\n"


@pytest.fixture
def content_dir(tmp_path: Path) -> Path:
    """A skills folder shaped like the one that ships with the package."""
    directory = tmp_path / "content" / paths.BLUEPRINTS_SKILL_NAME / paths.BLUEPRINTS_DIR_NAME
    directory.mkdir(parents=True)
    return tmp_path / "content"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A project Specrun has been installed into."""
    root = tmp_path / "project"
    root.mkdir()
    return root


def write_bundled(content_dir: Path, name: str, header: str) -> Path:
    path = content_dir / paths.BLUEPRINTS_SKILL_NAME / paths.BLUEPRINTS_DIR_NAME / f"{name}.md"
    path.write_text(blueprint_file(header), encoding="utf-8")
    return path


def write_local(project: Path, name: str, header: str) -> Path:
    directory = paths.local_blueprints_dir(project)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.md"
    path.write_text(blueprint_file(header), encoding="utf-8")
    return path


def write_skill(content_dir: Path, name: str, files: dict[str, str]) -> Path:
    """A standalone skill folder in the content, such as `blueprint-author`."""
    directory = content_dir / name
    for relative, contents in files.items():
        path = directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
    return directory


def write_index(
    content_dir: Path,
    entries: list[dict[str, object]],
    version: str = "0.1.0",
    skills: list[str] | None = None,
) -> Path:
    path = content_dir / paths.BLUEPRINTS_SKILL_NAME / paths.INDEX_FILE_NAME
    path.write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "content_version": version,
                "blueprints": entries,
                "skills": skills or [],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return path
