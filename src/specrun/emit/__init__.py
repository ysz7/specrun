"""Turning blueprints into the files an agent reads.

An emitter is a pure function of the content: it takes the blueprints and gives back a mapping of
relative path to file contents. It does not touch the disk, does not know whether a file already
exists, and does not hash anything — the caller writes, compares and reports, which is what makes
the hash rule testable without a filesystem and what keeps agent-specific formatting in one place.

There is one emitter, for Claude Code. No abstraction is invented for agents that do not exist
yet; the separation that matters is between deciding what a file should contain and deciding
whether it may be written.
"""

from __future__ import annotations

from . import claude

#: The only target for now. `lock.json` records it so a later version can tell what it is looking
#: at, and so adding a second target does not require guessing what the first one wrote.
DEFAULT_TARGET = "claude"

EMITTERS = {DEFAULT_TARGET: claude.emit}

__all__ = ["DEFAULT_TARGET", "EMITTERS", "claude"]
