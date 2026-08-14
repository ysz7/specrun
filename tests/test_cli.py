"""The CLI's shape: the commands that exist, and what a stub does."""

from __future__ import annotations

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


@pytest.mark.parametrize("command", [c for c in COMMANDS if c != "init"])
def test_stub_commands_fail_loudly(
    command: str, capsys: pytest.CaptureFixture[str]
) -> None:
    # A stub that exited zero would tell a script it had succeeded.
    assert main([command]) == 1
    assert "not implemented" in capsys.readouterr().err


def test_unknown_command_is_rejected() -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["nonsense"])
    assert exit_info.value.code != 0
