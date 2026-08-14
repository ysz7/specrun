"""Locating the content that ships with the package.

The skills folder has two homes and one name. It lives in `plugins/specrun/skills/` in the
repository, because the Claude Code marketplace reads files straight from git and has no build
step; when a wheel is built it is copied to `specrun/_content/skills/` inside the package. Every
other module asks this function where it is and never spells either path out.
"""

from __future__ import annotations

from pathlib import Path

from . import paths


class ContentNotFound(RuntimeError):
    """The bundled content is missing from both of the places it can legitimately be."""


def content_root() -> Path:
    """Absolute path to the bundled skills folder.

    Raises `ContentNotFound` rather than returning an empty or non-existent path. The failure
    this guards against is quiet: a missing folder would read as "this installation has no
    blueprints", which looks like an empty install rather than a broken one, and every command
    downstream would go on working on nothing.
    """
    packaged = paths.PACKAGED_CONTENT_DIR / paths.SKILLS_DIR_NAME
    if packaged.is_dir():
        return packaged

    # Development fallback. An editable install copies the content into site-packages, but
    # `import specrun` resolves through a .pth file to the source tree, so the packaged path
    # above does not exist and the repository copy is the real one.
    source = _repository_skills_dir()
    if source is not None:
        return source

    raise ContentNotFound(
        "Specrun cannot find its bundled skills. Looked for the packaged copy at "
        f"{packaged}, and for a source checkout at "
        f"<repo>/{paths.PLUGIN_DIR / paths.SKILLS_DIR_NAME} above {Path(__file__).resolve()}. "
        "A wheel is built with a force-include rule that copies the plugin's skills folder into "
        "the package; if this is an installed copy, that build step did not run."
    )


def _repository_skills_dir() -> Path | None:
    """The skills folder in a source checkout, found by walking up from this file."""
    relative = paths.PLUGIN_DIR / paths.SKILLS_DIR_NAME
    for parent in Path(__file__).resolve().parents:
        candidate = parent / relative
        if candidate.is_dir():
            return candidate
    return None
