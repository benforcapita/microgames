from __future__ import annotations

import os
import signal
import time
from pathlib import Path

import support
from categorizer.extract import Limits, run_sandboxed


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def test_child_returns_value(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, support.echo, {"k": [1, 2]}, limits=Limits())
    assert outcome.code is None
    assert outcome.value == {"k": [1, 2]}
    assert _gone(outcome.proc.pid)


def test_child_exception_is_extract_crash(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, support.explode, None, limits=Limits())
    assert outcome.code == "extract_crash"
    assert _gone(outcome.proc.pid)


def test_cpu_limit_kills_child(tmp_path: Path) -> None:
    started = time.monotonic()
    outcome = run_sandboxed(
        tmp_path,
        support.burn_cpu,
        None,
        limits=Limits(cpu_seconds=1, wall_seconds=15.0),
    )
    assert outcome.code == "extract_limit"
    assert time.monotonic() - started < 12.0
    assert _gone(outcome.proc.pid)


def test_memory_limit_kills_child(tmp_path: Path) -> None:
    outcome = run_sandboxed(
        tmp_path,
        support.eat_memory,
        900 * 1024 * 1024,
        limits=Limits(as_bytes=512 * 1024 * 1024, wall_seconds=30.0),
    )
    assert outcome.code == "extract_limit"
    assert not (tmp_path / "survived").exists()
    assert _gone(outcome.proc.pid)


def test_wall_clock_kills_child(tmp_path: Path) -> None:
    started = time.monotonic()
    outcome = run_sandboxed(
        tmp_path,
        support.sleep_seconds,
        30.0,
        limits=Limits(wall_seconds=0.5),
    )
    assert outcome.code == "extract_limit"
    assert outcome.proc.exitcode == -signal.SIGKILL
    assert time.monotonic() - started < 4.0
    assert _gone(outcome.proc.pid)


def test_sigxcpu_death_is_extract_limit(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, support.die_sigxcpu, None, limits=Limits())
    assert outcome.code == "extract_limit"
    assert outcome.proc.exitcode == -signal.SIGXCPU
    assert _gone(outcome.proc.pid)


def test_open_files_limit_restricts_child(tmp_path: Path) -> None:
    outcome = run_sandboxed(
        tmp_path,
        support.count_openable,
        40,
        limits=Limits(open_files=8, wall_seconds=15.0),
    )
    assert outcome.code is None
    assert outcome.value <= 8
    assert _gone(outcome.proc.pid)


def test_network_is_denied_in_child(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, support.open_socket, None, limits=Limits())
    assert outcome.code == "extract_crash"
    assert _gone(outcome.proc.pid)


def test_bad_worker_is_extract_crash(tmp_path: Path) -> None:
    outcome = run_sandboxed(tmp_path, len, None, limits=Limits())
    assert outcome.code == "extract_crash"
    assert _gone(outcome.proc.pid)
