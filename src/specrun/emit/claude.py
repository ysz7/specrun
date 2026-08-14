"""The Claude Code emitter: the only module that knows what Claude Code expects on disk.

It produces two things — a router skill whose description decides whether any blueprint is worth
reading at all, and a copy of each blueprint next to it. Blueprints are copied whole, header
included: the header is how `blueprint-author` later knows a blueprint's id, when it was last
verified, and whether a local file was based on it.

Note on the router text. The description below has been through the description-optimisation run
described in PLAN.md phase 5b: twenty realistic queries, twelve of them meant to trigger and eight
meant not to, three runs each. It held 8/8 on the held-out queries and 11/12 on the training ones,
and a rewrite that scored better on training scored worse on the holdout — so it is kept as it
stands. Changing it means running that measurement again, not judging the wording by eye.
"""

from __future__ import annotations

from typing import Sequence

from .. import paths
from ..frontmatter import Blueprint

#: The description is the whole triggering mechanism: Claude sees the skill's name and this text,
#: and nothing else, when deciding whether to open it. `{topics}` is filled with the blueprints
#: actually installed, because what this skill covers is not fixed — a project with different
#: blueprints must not advertise the ones it does not have.
ROUTER_DESCRIPTION_TEMPLATE = (
    "Architectural blueprints this project has already settled on, covering {topics}. "
    "Use when building, extending or fixing a feature in one of those areas, so the work follows "
    "the recorded approach and its reasoning instead of being designed again from scratch. "
    "Not for topics with no blueprint here, and not for ordinary coding questions."
)


def description(blueprints: Sequence[Blueprint]) -> str:
    """The frontmatter description, naming the blueprints that are actually installed."""
    titles = [b.title.lower() for b in sorted(blueprints, key=lambda b: b.id)]
    if not titles:
        topics = "no blueprints yet"
    elif len(titles) == 1:
        topics = titles[0]
    else:
        topics = ", ".join(titles[:-1]) + " and " + titles[-1]
    return ROUTER_DESCRIPTION_TEMPLATE.format(topics=topics)


def emit(blueprints: Sequence[Blueprint]) -> dict[str, str]:
    """Blueprints in, `{relative path: contents}` out. Touches nothing."""
    files: dict[str, str] = {
        str(paths.rel_skill_manifest(paths.BLUEPRINTS_SKILL_NAME)): router(blueprints)
    }
    for blueprint in blueprints:
        files[str(paths.rel_blueprint_copy(blueprint.id))] = blueprint.path.read_text(
            encoding="utf-8"
        )
    return files


def router(blueprints: Sequence[Blueprint]) -> str:
    """The skill that decides which blueprint, if any, fits the task in hand."""
    lines = [
        "---",
        f"name: {paths.BLUEPRINTS_SKILL_NAME}",
        f"description: {description(blueprints)}",
        "---",
        "",
        "# Blueprints",
        "",
        "A blueprint records how this project builds a particular kind of thing: the shape, the",
        "contracts, the failure modes, and why each choice was made. Following one keeps a new",
        "feature consistent with what is already here — which usually matters more than whether",
        "any single decision inside it was the best available.",
        "",
        "## Choosing one",
        "",
        "Match the task against the *when it applies* column below, then read that file in full.",
        "",
        "If nothing matches, there is no blueprint for this work. Say so and carry on normally: a",
        "blueprint stretched over a task it was not written for imports decisions that were made",
        "for a different problem, which is worse than having no blueprint at all.",
        "",
        "| Blueprint | When it applies |",
        "|---|---|",
    ]

    for blueprint in sorted(blueprints, key=lambda b: b.id):
        path = paths.rel_blueprint_copy(blueprint.id).name
        local = " *(local)*" if blueprint.is_local else ""
        lines.append(
            f"| [{blueprint.title}]({paths.BLUEPRINTS_DIR_NAME}/{path}){local} "
            f"| {blueprint.use_when} |"
        )

    lines += [
        "",
        "## Using one",
        "",
        "Read the whole file before writing anything. A blueprint is not a template to copy from:",
        "it says which decisions are settled and why, so the parts that do not fit the task at",
        "hand can be dropped deliberately rather than by accident.",
        "",
        "Blueprints record versions they were checked against and go out of date. Where a",
        "blueprint's assumptions no longer hold — a library has moved on, the code already does",
        "something else for a reason — follow the code and say what disagreed, rather than",
        "reshaping working code to match a stale document.",
        "",
        "Say which blueprint is being followed, and say where the implementation departs from it.",
        "The silent departure is the expensive one: the next person reads the blueprint and",
        "expects the code to match it.",
        "",
    ]

    if any(b.is_local for b in blueprints):
        lines += [
            "Blueprints marked *(local)* were written by this project and take precedence over",
            "the bundled ones they replace.",
            "",
        ]

    return "\n".join(lines)
