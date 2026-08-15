"""The scanner: everything it reports has to be on the disk it read."""

from __future__ import annotations

from pathlib import Path

import pytest

from specrun.scan import scan

PYPROJECT = """
[project]
name = "sample"
dependencies = ["httpx>=0.27", "rich"]

[project.optional-dependencies]
pdf = ["reportlab"]

[project.scripts]
sample = "app.cli:main"

[dependency-groups]
dev = ["pytest>=8"]
"""

PACKAGE_JSON = """
{
  "name": "sample-web",
  "main": "web/index.ts",
  "scripts": {"start": "node web/index.ts"},
  "dependencies": {"react": "^19.0.0"},
  "devDependencies": {"vitest": "^2.0.0"}
}
"""


def write(root: Path, path: str, text: str = "") -> Path:
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8")
    return file


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A small repository with one of everything the scanner claims to see."""
    root = tmp_path / "sample"
    root.mkdir()

    write(root, ".gitignore", "generated/\n*.log\n")
    write(root, "pyproject.toml", PYPROJECT)
    write(root, "package.json", PACKAGE_JSON)

    write(root, "src/app/__init__.py")
    write(root, "src/app/cli.py", "import json\nfrom service import queries\n\n\ndef main():\n    ...\n")
    write(root, "src/app/__main__.py", "from app.cli import main\n")
    write(root, "src/service/__init__.py")
    write(root, "src/service/queries.py", "import httpx\n")

    write(root, "tests/test_app.py", "from app import cli\n")

    write(root, "web/index.ts", "import { helper } from './util';\n")
    write(root, "web/util.ts", "export const helper = 1;\n")

    write(root, ".github/workflows/ci.yml", "name: ci\n")
    write(root, "Dockerfile", "FROM python:3.12\n")
    write(root, "infra/main.tf", 'resource "aws_s3_bucket" "b" {}\n')
    write(root, "infra/dns.tf", "")
    write(root, "docs/guide.md", "# Guide\n")

    write(root, "generated/huge.py", "x = 1\n")
    write(root, "debug.log", "noise\n")
    write(root, "node_modules/left-pad/index.js", "module.exports = 1;\n")

    return root


def test_ignored_and_noisy_files_are_not_facts(repo: Path) -> None:
    paths = {module.path for module in scan(repo).modules}
    assert "generated" not in paths
    assert "node_modules" not in paths
    assert scan(repo).file_count == len(
        [p for p in repo.rglob("*") if p.is_file()]
    ) - 3  # generated/huge.py, debug.log, node_modules/left-pad/index.js


def test_modules_are_the_units_under_a_source_root(repo: Path) -> None:
    modules = {module.name: module for module in scan(repo).modules}

    assert set(modules) == {"app", "service", "tests", "web"}
    assert modules["app"].path == "src/app"
    assert modules["app"].language == "python"
    assert modules["web"].language == "typescript"
    # docs/ holds no code, so it is a directory in the tree and not a module in the graph.
    assert "docs" not in modules


def test_code_in_the_root_is_a_module_under_the_project_name(tmp_path: Path) -> None:
    # A Go or single-file Python project keeps its code at the top, and "no modules" would be
    # the wrong answer for it.
    root = tmp_path / "flat"
    write(root, "main.go", "package main\n")
    write(root, "server.go", "package main\n")

    modules = scan(root).modules

    assert [(m.name, m.path, m.files) for m in modules] == [("flat", ".", 2)]


def test_imports_join_modules_and_leave_dependencies_out(repo: Path) -> None:
    edges = {(edge.source, edge.target): edge.count for edge in scan(repo).imports}

    assert edges[("app", "service")] == 1
    assert edges[("tests", "app")] == 1
    # `httpx` is a dependency and is reported as one; an edge to it would be a map of PyPI.
    assert not any(target == "httpx" for _, target in edges)
    # A relative import stays inside its own module rather than becoming a self-edge.
    assert not any(source == target for source, target in edges)


def test_relative_javascript_imports_resolve_to_a_module(tmp_path: Path) -> None:
    root = tmp_path / "js"
    write(root, "app/main.ts", "import { q } from '../shared/db';\n")
    write(root, "shared/db.ts", "export const q = 1;\n")

    edges = {(edge.source, edge.target) for edge in scan(root).imports}

    assert ("app", "shared") in edges


def test_dependencies_carry_their_scope_and_manifest(repo: Path) -> None:
    dependencies = {(d.name, d.scope, d.manifest) for d in scan(repo).dependencies}

    assert ("httpx", "runtime", "pyproject.toml") in dependencies
    assert ("pytest", "dev", "pyproject.toml") in dependencies
    assert ("reportlab", "optional:pdf", "pyproject.toml") in dependencies
    assert ("react", "runtime", "package.json") in dependencies
    assert ("vitest", "dev", "package.json") in dependencies


def test_version_specifiers_are_split_off_the_name(repo: Path) -> None:
    httpx = next(d for d in scan(repo).dependencies if d.name == "httpx")
    assert httpx.version == ">=0.27"


GO_MOD = """
module github.com/acme/tool

go 1.22

require (
	github.com/spf13/cobra v1.8.0
	golang.org/x/sys v0.20.0 // indirect
)
"""

CARGO_TOML = """
[package]
name = "tool"

[dependencies]
serde = "1.0"

[dev-dependencies]
proptest = "1.4"
"""


@pytest.mark.parametrize(
    ("manifest", "text", "expected"),
    [
        ("go.mod", GO_MOD, {("github.com/spf13/cobra", "runtime"), ("golang.org/x/sys", "indirect")}),
        ("Cargo.toml", CARGO_TOML, {("serde", "runtime"), ("proptest", "dev")}),
        ("requirements.txt", "flask==3.0\n# comment\n-r other.txt\n", {("flask", "runtime")}),
        ("composer.json", '{"require": {"php": "^8", "monolog/monolog": "^3"}}', {("monolog/monolog", "runtime")}),
        ("Gemfile", "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n", {("rails", "runtime")}),
    ],
)
def test_every_manifest_reader(
    tmp_path: Path, manifest: str, text: str, expected: set[tuple[str, str]]
) -> None:
    root = tmp_path / "manifest"
    write(root, manifest, text)

    found = {(d.name, d.scope) for d in scan(root).dependencies}

    assert found == expected


def test_unreadable_manifests_do_not_stop_a_scan(tmp_path: Path) -> None:
    root = tmp_path / "broken"
    write(root, "pyproject.toml", "[project\nname = ")
    write(root, "src/app/main.py", "print(1)\n")

    report = scan(root)

    assert report.dependencies == ()
    assert [module.name for module in report.modules] == ["app"]


def test_symlinked_directories_are_not_followed(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    write(outside, "theirs.py", "x = 1\n")
    root = tmp_path / "linked"
    write(root, "src/app/main.py", "print(1)\n")
    (root / "vendor").symlink_to(outside, target_is_directory=True)

    # A link out of the tree reports someone else's files as this project's; a link back into it
    # never finishes.
    assert all("vendor" not in module.path for module in scan(root).modules)


def test_entry_points_prefer_the_manifest_and_fall_back_to_names(repo: Path) -> None:
    entries = {(entry.name, entry.path) for entry in scan(repo).entry_points}

    assert ("sample", "app.cli:main") in entries
    assert ("start", "node web/index.ts") in entries
    assert ("__main__.py", "src/app/__main__.py") in entries


def test_infrastructure_is_reported_by_kind(repo: Path) -> None:
    found = {(item.kind, item.path) for item in scan(repo).infrastructure}

    assert ("ci", ".github/workflows/ci.yml") in found
    assert ("container", "Dockerfile") in found
    assert ("tests", "tests") in found
    assert ("docs", "docs") in found
    # Two .tf files in one directory are one fact about the project, not two.
    assert [item for item in found if item[0] == "infrastructure-as-code"] == [
        ("infrastructure-as-code", "infra")
    ]


def test_the_project_name_comes_from_a_manifest(repo: Path) -> None:
    assert scan(repo).name == "sample"


def test_the_name_falls_back_to_the_directory(tmp_path: Path) -> None:
    root = tmp_path / "nameless"
    write(root, "notes.txt", "hello\n")
    assert scan(root).name == "nameless"


def test_the_tree_counts_the_whole_subtree_and_stops_at_the_depth(repo: Path) -> None:
    tree = scan(repo, depth=1).tree
    assert tree is not None

    by_name = {child.name: child for child in tree.children}
    assert by_name["src"].total_files == 5
    assert by_name["src"].files == 0
    # Depth 1 shows `src` but not `src/app`, and says so rather than looking childless.
    assert by_name["src"].children == ()
    assert by_name["src"].truncated


def test_the_tree_reaches_deeper_when_asked(repo: Path) -> None:
    tree = scan(repo, depth=2).tree
    assert tree is not None

    src = next(child for child in tree.children if child.name == "src")
    assert {child.name for child in src.children} == {"app", "service"}
    assert not src.truncated


def test_a_walk_that_hit_its_limit_says_so(repo: Path) -> None:
    report = scan(repo, max_files=5)

    assert report.file_count == 5
    assert any("walk stopped" in note for note in report.notes)


def test_unparsable_source_is_counted_not_swallowed(repo: Path) -> None:
    write(repo, "src/app/broken.py", "def (:\n")

    report = scan(repo)

    assert any("could not be parsed" in note for note in report.notes)
    # The rest of the module is still reported.
    assert any(module.name == "app" for module in report.modules)


def test_a_filename_deep_in_the_tree_is_not_an_entry_point(repo: Path) -> None:
    write(repo, "tests/fixtures/app/main.py", "print(1)\n")
    write(repo, "src/app/plugins/deep/nested/main.py", "print(1)\n")

    paths = {entry.path for entry in scan(repo).entry_points}

    assert "tests/fixtures/app/main.py" not in paths
    assert "src/app/plugins/deep/nested/main.py" not in paths


def test_workspace_packages_are_imported_by_name(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    write(root, "packages/core/package.json", '{"name": "@acme/core"}\n')
    write(root, "packages/core/index.ts", "export const core = 1;\n")
    write(root, "packages/web/package.json", '{"name": "@acme/web"}\n')
    write(root, "packages/web/index.ts", "import { core } from '@acme/core/deep';\nimport React from 'react';\n")

    edges = {(edge.source, edge.target) for edge in scan(root).imports}

    assert ("web", "core") in edges
    # `react` is not in this repository, so it is a dependency and not an edge.
    assert not any(target == "react" for _, target in edges)


def test_a_wide_directory_is_summarised_rather_than_listed(tmp_path: Path) -> None:
    root = tmp_path / "wide"
    for number in range(20):
        write(root, f"cases/case{number:02d}/main.py", "print(1)\n")

    tree = scan(root, depth=2).tree
    assert tree is not None
    cases = next(child for child in tree.children if child.name == "cases")

    assert len(cases.children) == 12
    assert cases.hidden_children == 8
    assert cases.total_files == 20


def test_many_test_directories_become_a_count(tmp_path: Path) -> None:
    root = tmp_path / "many"
    for number in range(12):
        write(root, f"pkg{number:02d}/tests/test_it.py", "assert True\n")

    report = scan(root)

    assert len([item for item in report.infrastructure if item.kind == "tests"]) == 8
    assert any("more tests path(s)" in note for note in report.notes)


def test_the_json_form_carries_every_section(repo: Path) -> None:
    data = scan(repo).to_dict()

    assert set(data) == {
        "root",
        "name",
        "file_count",
        "languages",
        "tree",
        "modules",
        "imports",
        "dependencies",
        "entry_points",
        "infrastructure",
        "notes",
    }
    assert data["languages"][0]["name"] == "python"
