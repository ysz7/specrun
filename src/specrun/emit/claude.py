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
from ..index import Skill

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


#: Above this many blueprints the description names packs instead of every title. The description
#: is the one part of the skill that sits in the model's context permanently, so it has to stay
#: readable as a sentence; fifty titles is a list nobody parses, and the extra precision buys
#: nothing — the titles are all in the table one file away, and the table is what does the
#: choosing once the router has fired.
TITLE_LIMIT = 12


def description(blueprints: Sequence[Blueprint]) -> str:
    """The frontmatter description, naming the blueprints that are actually installed."""
    return ROUTER_DESCRIPTION_TEMPLATE.format(topics=_join(topics(blueprints)))


def topics(blueprints: Sequence[Blueprint]) -> list[str]:
    """What the description says the router covers: titles, or packs once there are many.

    A blueprint with no pack — every local one, unless its author chose to give it a pack — is
    named by its own title however long the list is. Otherwise a project's own blueprint would
    disappear from the description, and the description is the only thing that decides whether
    the router is opened at all.
    """
    ordered = sorted(blueprints, key=lambda b: b.id)
    if len(ordered) <= TITLE_LIMIT:
        return [b.title.lower() for b in ordered]

    labels = {b.pack or b.title.lower() for b in ordered}
    return sorted(labels, key=str.lower)


def _join(topics: Sequence[str]) -> str:
    if not topics:
        return "no blueprints yet"
    if len(topics) == 1:
        return topics[0]
    return ", ".join(topics[:-1]) + " and " + topics[-1]


def emit(blueprints: Sequence[Blueprint], skills: Sequence[Skill] = ()) -> dict[str, str]:
    """Content in, `{relative path: contents}` out. Touches nothing.

    Two kinds of thing come out. The router and the blueprints it offers are generated, because
    the table and the description depend on which blueprints this project actually has. A
    standalone skill such as `blueprint-author` is copied as it stands: it says the same thing in
    every project, it is not chosen by the router, and it carries its own description — which is
    the whole reason it is a skill of its own rather than another row in the table.
    """
    files: dict[str, str] = {
        str(paths.rel_skill_manifest(paths.BLUEPRINTS_SKILL_NAME)): router(blueprints, skills)
    }
    for blueprint in blueprints:
        files[str(paths.rel_blueprint_copy(blueprint.id))] = blueprint.path.read_text(
            encoding="utf-8"
        )
    for skill in skills:
        for relative, contents in skill.files.items():
            files[str(paths.rel_skill_dir(skill.name) / relative)] = contents
    return files


def router(blueprints: Sequence[Blueprint], skills: Sequence[Skill] = ()) -> str:
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
    ]

    # Disagreement with a blueprint is where a project's own knowledge shows up, and it shows up
    # here — while the blueprint is being followed — not at the moment someone thinks to write
    # one. Said right after the staleness paragraph and as a concrete offer, because a pointer at
    # the end of the file reads as background and the finding then dies in one conversation.
    if any(skill.name == paths.BLUEPRINT_AUTHOR_SKILL_NAME for skill in skills):
        lines += [
            "In any of those cases — the blueprint is past its own freshness date, the versions it",
            "was checked against are not the ones installed, or this project did something else on",
            "purpose and it worked — end by asking whether to write the project's own version of",
            f"it. The `{paths.BLUEPRINT_AUTHOR_SKILL_NAME}` skill does that: it records what",
            "differs and why, and leaves the original in place. Ask once and take a no as final;",
            "unasked, the finding lasts as long as this conversation does.",
            "",
        ]

    lines += [
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
