"""Every path and file name Specrun knows about.

This module exists so that no other file spells one of these strings out. A layout that is
written down in one place can be changed in one place; a layout scattered as string literals
across a dozen modules can only be changed by grep, and grep misses the one in the test.

Names are constants, locations are functions of a project root. Nothing here touches the disk.
"""

from __future__ import annotations

from pathlib import Path

# --- the package's own content -------------------------------------------------------------

#: Directory the skills folder is copied into when the wheel is built (see the force-include
#: rule in pyproject.toml). It does not exist in a source checkout — `content.py` falls back to
#: the plugin folder for development installs.
PACKAGED_CONTENT_DIR = Path(__file__).resolve().parent / "_content"

#: Where the same content lives in this repository, relative to the repository root. The Claude
#: Code marketplace reads it from here directly, so it has to be usable without a build step.
PLUGIN_DIR = Path("plugins") / "specrun"

SKILLS_DIR_NAME = "skills"

# --- skills ---------------------------------------------------------------------------------

#: The router skill: one description that decides which blueprint, if any, fits the task.
BLUEPRINTS_SKILL_NAME = "blueprints"
#: Creates or improves a blueprint after real work has been done.
BLUEPRINT_AUTHOR_SKILL_NAME = "blueprint-author"
#: Draws the architecture map.
MAP_SKILL_NAME = "map"

#: Blueprints sit in a folder of that name inside the router skill, and inside `.specrun/local/`.
BLUEPRINTS_DIR_NAME = "blueprints"

SKILL_FILE_NAME = "SKILL.md"
INDEX_FILE_NAME = "index.json"

# --- what Specrun writes into a project -----------------------------------------------------

#: Specrun's own folder inside a project it has been installed into.
PROJECT_DIR_NAME = ".specrun"
#: Owned by the project, never written or overwritten by Specrun after creation.
LOCAL_DIR_NAME = "local"
LOCK_FILE_NAME = "lock.json"
MAP_FILE_NAME = "map.html"

#: The emitter's target. The only Claude-Code-shaped name outside `emit/claude.py`; it lives
#: here so the whole layout stays visible in one file.
CLAUDE_DIR_NAME = ".claude"


def project_dir(root: Path) -> Path:
    """Specrun's folder inside the project at `root`."""
    return root / PROJECT_DIR_NAME


def lock_path(root: Path) -> Path:
    """The lock file recording every file Specrun wrote and the hash it wrote."""
    return project_dir(root) / LOCK_FILE_NAME


def local_dir(root: Path) -> Path:
    """The project's own content. Specrun reads it and never writes it."""
    return project_dir(root) / LOCAL_DIR_NAME


def local_blueprints_dir(root: Path) -> Path:
    """Blueprints written by the project, which shadow bundled ones with the same id."""
    return local_dir(root) / BLUEPRINTS_DIR_NAME


def map_path(root: Path) -> Path:
    """Default destination for a generated map."""
    return project_dir(root) / MAP_FILE_NAME


def claude_skills_dir(root: Path) -> Path:
    """Where the Claude Code emitter installs compiled skills."""
    return root / CLAUDE_DIR_NAME / SKILLS_DIR_NAME
