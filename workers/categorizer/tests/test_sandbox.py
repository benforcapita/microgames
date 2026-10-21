from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from categorizer.extract.sandbox import Limits, SandboxFailure, SandboxOk, run_sandboxed


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def test_child_returns_value(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, "support:echo", {"k": [1, 2]}, limits=Limits())
    assert isinstance(outcome, SandboxOk)
    assert outcome.value == {"k": [1, 2]}
    assert _gone(outcome.pid)


def test_child_exception_is_extract_crash(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, "support:explode", None, limits=Limits())
    assert isinstance(outcome, SandboxFailure)
    assert outcome.code == "extract_crash"
    assert _gone(outcome.pid)


def test_cpu_limit_kills_child(tmp_path: Path) -> None:
    started = time.monotonic()
    outcome = run_sandboxed(
        tmp_path, "support:burn_cpu", None, limits=Limits(cpu_seconds=1, wall_seconds=20.0)
    )
    elapsed = time.monotonic() - started
    assert isinstance(outcome, SandboxFailure)
    assert outcome.code == "extract_limit"
    assert elapsed < 15.0
    assert _gone(outcome.pid)


def test_memory_limit_kills_child(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, "support:eat_memory", None, limits=Limits())
    assert isinstance(outcome, SandboxFailure)
    assert outcome.code == "extract_limit"
    assert not (tmp_path / "survived").exists()
    assert _gone(outcome.pid)


def test_wall_clock_timeout_kills_child(tmp_path: Path) -> None:
    started = time.monotonic()
    outcome = run_sandboxed(
        tmp_path, "support:sleep_seconds", 5.0, limits=Limits(wall_seconds=0.5)
    )
    elapsed = time.monotonic() - started
    assert isinstance(outcome, SandboxFailure)
    assert outcome.code == "extract_limit"
    assert elapsed < 5.0
    assert _gone(outcome.pid)


def test_network_is_denied_in_child(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, "support:open_socket", None, limits=Limits())
    assert isinstance(outcome, SandboxFailure)
    assert outcome.code == "extract_crash"


@pytest.mark.parametrize("bad", ["missing_module:f", "support:missing_func", "nocolon"])
def test_bad_target_is_extract_crash(tmp_path: Path, bad: str) -> None:
    outcome = run_sandboxed(tmp_path, bad, None, limits=Limits())
    assert isinstance(outcome, SandboxFailure)
    assert outcome.code == "extract_crash"
