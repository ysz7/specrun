"""The CLI's shape: the commands that exist, and what a stub does."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from specrun import __version__
from specrun.cli import COMMANDS, main


def test_version_prints_the_package_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["--version"])
    assert exit_info.value.code == 0
    assert capsys.readouterr().out.strip() == f"specrun {__version__}"


def test_no_command_prints_help(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 0
    assert "usage: specrun" in capsys.readouterr().out


@pytest.mark.parametrize("command", COMMANDS)
def test_every_command_is_routed(
    command: str, project: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # `main` falls through to a "not implemented" message for anything it does not dispatch, so a
    # command listed but never wired up says so out loud instead of quietly doing nothing.
    main([command, "--cwd", str(project)])
    assert "not implemented" not in capsys.readouterr().err


@pytest.mark.parametrize("argv", [["scan", "--json"], ["--json", "scan"]])
def test_global_flags_are_accepted_on_either_side_of_the_command(
    argv: list[str], project: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main([*argv, "--cwd", str(project)]) == 0
    assert json.loads(capsys.readouterr().out)["name"] == project.name


def test_unknown_command_is_rejected() -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["nonsense"])
    assert exit_info.value.code != 0
