"""Reading one blueprint file."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from specrun.frontmatter import BlueprintError, parse, parse_duration, split
from tests.conftest import blueprint_file

FULL = """
id = "rag-baseline"
title = "RAG baseline"
use_when = "Search over documents returns the wrong passages"
pack = "ai-agents"
verified_at = 2026-08-01
stale_after = "90d"
verified_against = { anthropic-sdk = "0.40.x" }
"""


def test_reads_every_field() -> None:
    blueprint = parse(blueprint_file(FULL), Path("rag.md"))
    assert blueprint.id == "rag-baseline"
    assert blueprint.title == "RAG baseline"
    assert blueprint.use_when.startswith("Search over documents")
    assert blueprint.pack == "ai-agents"
    # A real date, not a string — which is the reason the header is TOML.
    assert blueprint.verified_at == date(2026, 8, 1)
    assert blueprint.verified_against == {"anthropic-sdk": "0.40.x"}
    assert blueprint.origin == "bundled"


def test_body_is_kept_apart_from_the_header() -> None:
    _header, body = split(blueprint_file(FULL, "First line.\n\nSecond line."))
    assert body == "First line.\n\nSecond line.\n"


@pytest.mark.parametrize("field", ["id", "title", "use_when"])
def test_a_blueprint_without_identity_or_a_trigger_is_rejected(field: str) -> None:
    header = "\n".join(line for line in FULL.strip().splitlines() if not line.startswith(field))
    with pytest.raises(BlueprintError, match=field):
        parse(blueprint_file(header), Path("rag.md"))


def test_an_empty_use_when_counts_as_missing() -> None:
    with pytest.raises(BlueprintError, match="use_when"):
        parse(blueprint_file('id = "x"\ntitle = "X"\nuse_when = "  "'), Path("x.md"))


@pytest.mark.parametrize(
    "text, message",
    [
        ("no header at all", "missing"),
        ("+++\nid = 1\n", "unterminated"),
        ("+++\nnot toml\n+++\n", "invalid TOML"),
    ],
)
def test_malformed_files_say_what_is_wrong(text: str, message: str) -> None:
    with pytest.raises(BlueprintError, match=message):
        parse(text, Path("broken.md"))


def test_errors_name_the_file() -> None:
    with pytest.raises(BlueprintError, match="broken.md"):
        parse(blueprint_file('title = "no id"\nuse_when = "never"'), Path("broken.md"))


@pytest.mark.parametrize("text, days", [("90d", 90), ("2w", 14), ("6m", 180), ("1y", 365)])
def test_durations(text: str, days: int) -> None:
    assert parse_duration(text).days == days


@pytest.mark.parametrize("text", ["90", "d", "ninety days", "-1d", ""])
def test_unreadable_durations_are_rejected(text: str) -> None:
    with pytest.raises(BlueprintError):
        parse_duration(text)


def test_a_bad_duration_is_caught_while_the_file_name_is_still_known() -> None:
    header = 'id = "x"\ntitle = "X"\nuse_when = "y"\nstale_after = "soon"'
    with pytest.raises(BlueprintError, match="duration"):
        parse(blueprint_file(header), Path("x.md"))


def test_staleness_is_measured_from_the_last_verification() -> None:
    blueprint = parse(blueprint_file(FULL), Path("rag.md"))
    assert not blueprint.stale_on(date(2026, 10, 29))
    assert blueprint.stale_on(date(2026, 10, 31))


def test_a_blueprint_that_claims_nothing_never_goes_stale() -> None:
    blueprint = parse(blueprint_file('id = "x"\ntitle = "X"\nuse_when = "y"'), Path("x.md"))
    assert not blueprint.stale_on(date(2099, 1, 1))
