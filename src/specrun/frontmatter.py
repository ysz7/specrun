"""Blueprint files: a TOML header, then the blueprint itself as markdown.

The header is fenced with `+++` rather than `---` because it really is TOML, and TOML is what
the standard library can parse. The alternative was a hand-written parser for a YAML subset,
which would have to grow a rule every time a value stopped being a plain string — the version
pins in `verified_against` are already a table, and `verified_at` is a date. `+++` is the
established marker for a TOML header, so the fence is not lying about what follows.

Nothing here reads a directory or validates a set of blueprints; this module turns one file into
one record and reports precisely which file was wrong when it cannot.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

FENCE = "+++"

#: Without these three a blueprint cannot be offered to a model: no identity, no name to show,
#: and — most importantly — nothing to match a task against.
REQUIRED_FIELDS = ("id", "title", "use_when")


class BlueprintError(ValueError):
    """A blueprint file that cannot be read as one."""


@dataclass(frozen=True)
class Blueprint:
    """One blueprint, as the index and the router see it."""

    id: str
    title: str
    #: The line the model actually reads when deciding whether this blueprint fits the task at
    #: hand. Everything else in the record is bookkeeping; this is the part that has to be right.
    use_when: str
    path: Path
    origin: str = "bundled"  # "bundled" or "local"
    pack: str | None = None
    verified_at: date | None = None
    stale_after: str | None = None
    #: Versions this blueprint was last checked against, e.g. {"anthropic-sdk": "0.40.x"}.
    verified_against: dict[str, str] = field(default_factory=dict)
    #: Set on a local blueprint that was written by overriding a bundled one.
    based_on: str | None = None
    #: Set during merging on a local blueprint that displaced a bundled one with the same id.
    shadows: str | None = None

    @property
    def is_local(self) -> bool:
        return self.origin == "local"

    def stale_on(self, today: date) -> bool:
        """Whether the blueprint's own promise of freshness has expired by `today`.

        A blueprint that says nothing about staleness never goes stale: silence means the author
        did not make the claim, not that the claim has run out.
        """
        if self.verified_at is None or self.stale_after is None:
            return False
        return today > self.verified_at + parse_duration(self.stale_after)


def parse_duration(text: str) -> timedelta:
    """`90d`, `12w`, `6m`, `1y` → a timedelta. Months and years are nominal (30 and 365 days)."""
    units = {"d": 1, "w": 7, "m": 30, "y": 365}
    raw = text.strip().lower()
    if len(raw) < 2 or raw[-1] not in units or not raw[:-1].isdigit():
        raise BlueprintError(
            f"cannot read {text!r} as a duration; expected a number followed by "
            f"one of {''.join(sorted(units))}, such as '90d'"
        )
    return timedelta(days=int(raw[:-1]) * units[raw[-1]])


def split(text: str, source: Path | None = None) -> tuple[dict[str, Any], str]:
    """Split a blueprint file into its header fields and its markdown body."""
    where = f" in {source}" if source else ""
    lines = text.lstrip("﻿").splitlines()
    if not lines or lines[0].strip() != FENCE:
        raise BlueprintError(f"missing {FENCE} header{where}")

    try:
        closing = next(i for i, line in enumerate(lines[1:], start=1) if line.strip() == FENCE)
    except StopIteration:
        raise BlueprintError(f"unterminated {FENCE} header{where}") from None

    try:
        header = tomllib.loads("\n".join(lines[1:closing]))
    except tomllib.TOMLDecodeError as error:
        raise BlueprintError(f"invalid TOML header{where}: {error}") from error

    # The body is copied into a project as a file of its own, so it ends with a newline whatever
    # the source did: a hash comparison against a file some editor has since fixed up would
    # otherwise report an edit nobody made.
    body = "\n".join(lines[closing + 1 :]).lstrip("\n")
    return header, body + "\n" if body else ""


def parse(text: str, path: Path, origin: str = "bundled") -> Blueprint:
    """Read one blueprint file. `path` is reported in errors and kept on the record."""
    header, _body = split(text, path)

    missing = [name for name in REQUIRED_FIELDS if not str(header.get(name, "")).strip()]
    if missing:
        raise BlueprintError(f"{path}: missing required field(s): {', '.join(missing)}")

    verified_at = header.get("verified_at")
    if verified_at is not None and not isinstance(verified_at, date):
        raise BlueprintError(
            f"{path}: verified_at must be a date such as 2026-08-01, not {verified_at!r}"
        )

    stale_after = header.get("stale_after")
    if stale_after is not None:
        parse_duration(str(stale_after))  # fail here, where the file name is still known

    return Blueprint(
        id=str(header["id"]).strip(),
        title=str(header["title"]).strip(),
        use_when=str(header["use_when"]).strip(),
        path=path,
        origin=origin,
        pack=_optional_str(header.get("pack")),
        verified_at=verified_at,
        stale_after=_optional_str(stale_after),
        verified_against={str(k): str(v) for k, v in (header.get("verified_against") or {}).items()},
        based_on=_optional_str(header.get("based_on")),
    )


def read(path: Path, origin: str = "bundled") -> Blueprint:
    """Read one blueprint from disk."""
    return parse(path.read_text(encoding="utf-8"), path, origin)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
