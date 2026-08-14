"""What kind of project this is, read from files that are already there.

Deliberately shallow. This is not a language detector and not a build-system probe: it answers
the few questions `init` has to answer out loud — is there an agent configured here, what is this
written in, are there tests — so that its summary describes the project the developer is looking
at rather than a generic one. Nothing here decides what gets installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import paths

#: Manifest → the name we print for it. Ordered, so the first match reads as the primary stack.
MANIFESTS: tuple[tuple[str, str], ...] = (
    ("pyproject.toml", "python"),
    ("setup.py", "python"),
    ("requirements.txt", "python"),
    ("package.json", "node"),
    ("Cargo.toml", "rust"),
    ("go.mod", "go"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("Gemfile", "ruby"),
    ("composer.json", "php"),
)

TEST_DIRS: tuple[str, ...] = ("tests", "test", "spec", "__tests__")


@dataclass(frozen=True)
class Project:
    """The little that Specrun needs to know about a project before writing to it."""

    root: Path
    stacks: tuple[str, ...] = ()
    has_agent_dir: bool = False
    has_tests: bool = False
    has_git: bool = False

    @property
    def stack(self) -> str:
        """The primary stack, or "unknown" — printed in the summary, never branched on."""
        return self.stacks[0] if self.stacks else "unknown"


def detect(root: Path) -> Project:
    """Look at `root` and report what is there. Reads directory entries only."""
    stacks: list[str] = []
    for manifest, name in MANIFESTS:
        if name not in stacks and (root / manifest).is_file():
            stacks.append(name)

    return Project(
        root=root,
        stacks=tuple(stacks),
        has_agent_dir=(root / paths.CLAUDE_DIR_NAME).is_dir(),
        has_tests=any((root / name).is_dir() for name in TEST_DIRS),
        has_git=(root / ".git").exists(),
    )
