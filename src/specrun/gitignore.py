"""Reading `.gitignore` well enough to walk a repository the way its author sees it.

The scanner reports facts about a project, and a fact drawn from `node_modules` or `.venv` is not
a fact about the project at all. Git already knows which files those are, and every repository
states it in a file that is right there — so the walk reads it rather than guessing from a list of
directory names that would be wrong for the next project.

This implements the parts of the format that decide what a walk sees: anchoring, `**`, directory-
only patterns, negation, and per-directory `.gitignore` files that apply below where they live.
The parts it leaves out are the ones that cannot change the outcome of a read-only walk —
`.git/info/exclude`, the global excludes file, and the index that makes an already-tracked file
immune to a later rule. A pattern is at worst read as slightly broader than git would read it,
which costs a directory in a report, not correctness in a build.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

GITIGNORE_FILE_NAME = ".gitignore"


@dataclass(frozen=True)
class Rule:
    """One pattern line, compiled against paths relative to the repository root."""

    regex: re.Pattern[str]
    negated: bool
    dir_only: bool
    #: The original line, kept so a surprising exclusion can be explained.
    source: str


@dataclass(frozen=True)
class Ignore:
    """The rules in force at some point in a walk.

    Immutable, and extended by `descend` as the walk enters directories that carry their own
    `.gitignore`. Later rules win over earlier ones, which is what puts a nested file's opinion
    above the root's and a `!` line above the rule it undoes.
    """

    rules: tuple[Rule, ...] = ()

    def match(self, path: str, is_dir: bool) -> bool:
        """Whether `path` — repository-relative, POSIX — is excluded."""
        excluded = False
        for rule in self.rules:
            if rule.dir_only and not is_dir:
                continue
            if rule.regex.match(path):
                excluded = not rule.negated
        return excluded

    def descend(self, directory: Path, base: str) -> Ignore:
        """The rules that apply inside `directory`, whose path from the root is `base`."""
        file = directory / GITIGNORE_FILE_NAME
        if not file.is_file():
            return self
        try:
            text = file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return self
        return Ignore(self.rules + parse(text, base))


def load(root: Path) -> Ignore:
    """The rules a repository states at its root, plus the ones no walk ever wants.

    `.git` is not in `.gitignore` — git has no need to say it — and a walk that reads it collects
    thousands of objects that are not the project.
    """
    return Ignore(parse(".git/\n", "")).descend(root, "")


def parse(text: str, base: str = "") -> tuple[Rule, ...]:
    """Compile the lines of one `.gitignore`, living at `base`, into rules."""
    rules: list[Rule] = []
    for raw in text.splitlines():
        rule = _rule(raw, base)
        if rule is not None:
            rules.append(rule)
    return tuple(rules)


def _rule(line: str, base: str) -> Rule | None:
    source = line
    # Trailing whitespace is not part of a pattern unless the last space was escaped.
    stripped = line.rstrip() if not line.endswith("\\ ") else line
    if not stripped.strip() or stripped.lstrip().startswith("#"):
        return None

    pattern = stripped
    negated = pattern.startswith("!")
    if negated:
        pattern = pattern[1:]
    if pattern.startswith("\\"):
        # An escaped leading `#` or `!`, which is otherwise significant.
        pattern = pattern[1:]

    dir_only = pattern.endswith("/")
    pattern = pattern.rstrip("/")
    if not pattern:
        return None

    # A pattern with a slash anywhere but at the end is read from the directory it was written
    # in; one without is read at any depth below it. That single rule is the whole of anchoring.
    anchored = "/" in pattern
    if pattern.startswith("/"):
        pattern = pattern[1:]

    prefix = f"{base}/" if base else ""
    body = _translate(pattern)
    head = re.escape(prefix) if anchored else re.escape(prefix) + "(?:[^/]+/)*"
    # A directory that matches carries its contents with it, so the walk can prune and the
    # matcher still answers correctly for a file handed to it directly.
    return Rule(
        regex=re.compile(f"^{head}{body}(?:/.*)?$"),
        negated=negated,
        dir_only=dir_only,
        source=source,
    )


def _translate(pattern: str) -> str:
    """Glob to regex, with `*` stopping at a path separator and `**` crossing them."""
    out: list[str] = []
    index = 0
    end = len(pattern)
    while index < end:
        char = pattern[index]
        if char == "*":
            if pattern[index : index + 2] == "**":
                after = index + 2
                spans_segments = (index == 0 or pattern[index - 1] == "/") and (
                    after == end or pattern[after] == "/"
                )
                if spans_segments:
                    if after < end:
                        out.append("(?:[^/]+/)*")
                        index = after + 1
                    else:
                        out.append(".*")
                        index = after
                    continue
                out.append(".*")
                index = after
                continue
            out.append("[^/]*")
            index += 1
            continue
        if char == "?":
            out.append("[^/]")
            index += 1
            continue
        if char == "[":
            close = pattern.find("]", index + 1)
            if close == -1:
                out.append(re.escape(char))
                index += 1
                continue
            body = pattern[index + 1 : close]
            if body.startswith("!"):
                body = "^" + body[1:]
            out.append(f"[{body}]")
            index = close + 1
            continue
        if char == "\\" and index + 1 < end:
            out.append(re.escape(pattern[index + 1]))
            index += 2
            continue
        out.append(re.escape(char))
        index += 1
    return "".join(out)
