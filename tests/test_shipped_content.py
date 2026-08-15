"""Invariants of the content that actually ships, as opposed to content a test built.

Everything else in this suite feeds the code fixtures. These tests read the real
`plugins/specrun/skills/` folder, because it is shipped twice — the marketplace serves it straight
from git with no build step, and the wheel carries a copy — and neither channel has a reviewer
between the file and the user. A blueprint whose header stopped parsing, an index that no longer
matches the headers it was generated from, or a map template that grew a reference to a CDN would
all pass every other test in this file's siblings and break in a user's project.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from specrun import paths
from specrun.content import content_root
from specrun.dev import reindex
from specrun.frontmatter import read
from specrun.index import bundled_blueprints_dir, bundled_index_path

CONTENT = content_root()

#: Skill folders carry Claude Code's own frontmatter, which is YAML and not ours to parse. Only
#: the two fields that decide whether a skill is ever reached are checked, and by line.
FRONTMATTER_FIELD = re.compile(r"^(?P<name>[a-z-]+):\s*(?P<value>.+)$")


def skill_dirs() -> list[Path]:
    return sorted(d for d in CONTENT.iterdir() if (d / paths.SKILL_FILE_NAME).is_file())


def frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    assert lines and lines[0].strip() == "---", "a skill starts with a --- frontmatter block"
    closing = next(i for i, line in enumerate(lines[1:], start=1) if line.strip() == "---")
    fields = {}
    for line in lines[1:closing]:
        match = FRONTMATTER_FIELD.match(line)
        if match:
            fields[match["name"]] = match["value"].strip()
    return fields


@pytest.mark.parametrize("directory", skill_dirs(), ids=lambda d: d.name)
def test_every_shipped_skill_declares_the_name_and_description_it_is_found_by(
    directory: Path,
) -> None:
    # The description is the entire triggering mechanism: a skill Claude never selects is not a
    # degraded skill, it is an absent one, and nothing at runtime reports its absence.
    fields = frontmatter((directory / paths.SKILL_FILE_NAME).read_text(encoding="utf-8"))

    assert fields.get("name") == directory.name
    assert len(fields.get("description", "")) > 80


def test_the_committed_generated_files_match_the_blueprint_headers() -> None:
    # The same check CI runs, over both generated files: the index the package reads, and the
    # router the marketplace serves. Kept here as well so that editing a header and running the
    # tests is enough to catch it, without waiting for a pull request.
    version = json.loads(bundled_index_path(CONTENT).read_text(encoding="utf-8"))["content_version"]

    for target, rendered in reindex.generated(CONTENT, version).items():
        assert target.is_file(), f"{target} is generated but not committed"
        assert target.read_text(encoding="utf-8") == rendered, (
            f"{target} is out of date; run `python -m specrun.dev.reindex`"
        )


def test_the_marketplace_copy_of_the_router_offers_every_bundled_blueprint() -> None:
    # The marketplace has no build step, so this committed router is the only thing standing
    # between a plugin install and three blueprint files nothing ever points at.
    router = (CONTENT / paths.BLUEPRINTS_SKILL_NAME / paths.SKILL_FILE_NAME).read_text(
        encoding="utf-8"
    )

    for path in sorted(bundled_blueprints_dir(CONTENT).glob("*.md")):
        assert f"({paths.BLUEPRINTS_DIR_NAME}/{path.name})" in router
    # And it must not advertise a project's local blueprints, which it cannot see from here.
    assert "*(local)*" not in router


def test_every_bundled_blueprint_parses_and_is_named_after_its_id() -> None:
    files = sorted(bundled_blueprints_dir(CONTENT).glob("*.md"))
    assert files, "the package ships with no blueprints at all"

    for path in files:
        blueprint = read(path)
        # The installed copy is written to `<id>.md`, so an id that disagrees with the file name
        # here would quietly rename the blueprint on its way into a project.
        assert blueprint.id == path.stem


def test_the_map_skill_states_the_budget_that_keeps_a_map_readable() -> None:
    # The budget is the one instruction in that skill a model is most tempted to exceed — every
    # additional box looks like additional value while it is being drawn. If a rewrite drops the
    # numbers, maps get wider and nothing fails until someone looks at one.
    text = (CONTENT / paths.MAP_SKILL_NAME / paths.SKILL_FILE_NAME).read_text(encoding="utf-8")
    budget = text.split("### The budget", 1)[1].split("###", 1)[0]

    assert "**9 blocks at the top level**" in budget
    assert "**7 children**" in budget
    assert "**3 levels**" in budget
    # A number without its reason is a rule to be argued with; the skill has to say why.
    assert "wall" in budget


def test_the_map_template_stays_a_file_that_opens_without_a_network() -> None:
    # The map is one self-contained HTML file so it can be mailed, committed or opened from a
    # download folder. A single external reference turns it into a page that is blank offline.
    template = CONTENT / paths.MAP_SKILL_NAME / "assets" / "template.html"
    # The SVG namespace is a URI that identifies a dialect, not an address anything is fetched
    # from, so it is the one occurrence of a scheme that has to be allowed through.
    text = template.read_text(encoding="utf-8").replace("http://www.w3.org/2000/svg", "")

    assert "http://" not in text
    assert "https://" not in text
    assert "@import" not in text


def test_the_map_skill_carries_the_licence_of_the_work_it_is_based_on() -> None:
    # MIT keeps its notice with the derivative. This one travels inside the skill folder, so it
    # reaches a project through both channels rather than living only in this repository.
    licence = (CONTENT / paths.MAP_SKILL_NAME / "THIRD_PARTY_LICENSES").read_text(encoding="utf-8")

    assert "Cocoon" in licence
    assert "MIT" in licence
