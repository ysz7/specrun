"""The parts of `.gitignore` that decide what a walk sees."""

from __future__ import annotations

from pathlib import Path

import pytest

from specrun.gitignore import Ignore, load, parse


def matcher(text: str, base: str = "") -> Ignore:
    return Ignore(parse(text, base))


@pytest.mark.parametrize(
    ("pattern", "path", "expected"),
    [
        ("build", "build", True),
        ("build", "src/build", True),
        ("build", "src/build/out.js", True),
        ("build", "rebuild", False),
        ("/build", "build", True),
        ("/build", "src/build", False),
        ("*.log", "app.log", True),
        ("*.log", "logs/app.log", True),
        ("*.log", "app.log.txt", False),
        ("src/*.py", "src/a.py", True),
        ("src/*.py", "src/pkg/a.py", False),
        ("src/**/*.py", "src/pkg/deep/a.py", True),
        ("src/**", "src/pkg/a.py", True),
        ("**/fixtures", "a/b/fixtures", True),
        ("doc?.md", "doc1.md", True),
        ("doc?.md", "doc12.md", False),
        ("[Bb]uild", "build", True),
    ],
)
def test_pattern_matching(pattern: str, path: str, expected: bool) -> None:
    assert matcher(pattern).match(path, is_dir=False) is expected


def test_directory_only_patterns_ignore_files_of_the_same_name() -> None:
    ignore = matcher("cache/")
    assert ignore.match("cache", is_dir=True)
    assert not ignore.match("cache", is_dir=False)


def test_later_rules_win_so_negation_reinstates() -> None:
    ignore = matcher("*.log\n!keep.log\n")
    assert ignore.match("app.log", is_dir=False)
    assert not ignore.match("keep.log", is_dir=False)


def test_comments_and_blank_lines_are_not_patterns() -> None:
    assert not matcher("# build\n\n   \n").rules


def test_a_nested_ignore_file_applies_below_where_it_lives(tmp_path: Path) -> None:
    nested = tmp_path / "pkg"
    nested.mkdir()
    (nested / ".gitignore").write_text("out\n", encoding="utf-8")

    ignore = Ignore().descend(nested, "pkg")

    assert ignore.match("pkg/out", is_dir=True)
    assert not ignore.match("out", is_dir=True)


def test_the_git_directory_is_excluded_without_being_listed(tmp_path: Path) -> None:
    # No repository writes `.git` into its own .gitignore, and no walk wants to read it.
    assert load(tmp_path).match(".git", is_dir=True)
