from __future__ import annotations

import importlib
import multiprocessing
import os
import resource
import signal
import socket
import time
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Literal, NamedTuple

ExtractCode = Literal["bundle_path", "extract_limit", "extract_crash", "extract_image"]
_LIMIT_SIGNALS = (-signal.SIGXCPU, -signal.SIGKILL)


class ExtractFailed(Exception):
    __slots__ = ("code",)

    def __init__(self, code: ExtractCode) -> None:
        super().__init__(code)
        self.code = code


class Limits(NamedTuple):
    as_bytes: int = 768 * 1024 * 1024
    cpu_seconds: int = 20
    open_files: int = 64
    wall_seconds: float = 60.0


DEFAULT_LIMITS = Limits()


class SandboxOk(NamedTuple):
    value: object
    pid: int


class SandboxFailure(NamedTuple):
    code: str
    pid: int


def run_sandboxed(
    work_dir: Path, target: str, payload: object, *, limits: Limits = DEFAULT_LIMITS
) -> SandboxOk | SandboxFailure:
    ctx = multiprocessing.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_entry, args=(child_conn, str(work_dir), target, payload, limits))
    proc.start()
    child_conn.close()
    pid = proc.pid if proc.pid is not None else -1
    deadline = time.monotonic() + limits.wall_seconds
    message = _recv(parent_conn, deadline)
    parent_conn.close()
    proc.join(max(deadline - time.monotonic(), 0.0))
    timed_out = proc.is_alive()
    if timed_out:
        proc.kill()
        proc.join()
    if message is None:
        code = (
            "extract_limit"
            if timed_out or proc.exitcode in _LIMIT_SIGNALS
            else "extract_crash"
        )
        return SandboxFailure(code=code, pid=pid)
    if message[0] == "ok" and len(message) == 2:
        return SandboxOk(value=message[1], pid=pid)
    if message[0] == "fail" and len(message) == 2 and isinstance(message[1], str):
        return SandboxFailure(code=message[1], pid=pid)
    if message[0] == "limit":
        return SandboxFailure(code="extract_limit", pid=pid)
    return SandboxFailure(code="extract_crash", pid=pid)


def _recv(conn: Connection, deadline: float) -> tuple[object, ...] | None:
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not conn.poll(remaining):
        return None
    try:
        msg = conn.recv()
    except (EOFError, OSError):
        return None
    return msg if isinstance(msg, tuple) and len(msg) > 0 else None


def _entry(
    conn: Connection, work_dir: str, target: str, payload: object, limits: Limits
) -> None:
    try:
        module, _colon, func = target.partition(":")
        work = getattr(importlib.import_module(module), func)
        _lockdown(limits, work_dir)
        conn.send(("ok", work(Path(work_dir), payload)))
    except ExtractFailed as err:
        _send(conn, ("fail", err.code))
    except MemoryError:
        _send(conn, ("limit",))
    except BaseException:
        _send(conn, ("crash",))
    finally:
        conn.close()


def _lockdown(limits: Limits, work_dir: str) -> None:
    os.chdir(work_dir)
    socket.socket = _DeniedSocket
    resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
    resource.setrlimit(resource.RLIMIT_AS, (limits.as_bytes, limits.as_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (limits.open_files, limits.open_files))


def _send(conn: Connection, message: tuple[str, object]) -> None:
    try:
        conn.send(message)
    except OSError:
        return


class _DeniedSocket(socket.socket):
    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise OSError("network disabled")


__all__ = (
    "DEFAULT_LIMITS",
    "ExtractCode",
    "ExtractFailed",
    "Limits",
    "SandboxFailure",
    "SandboxOk",
    "run_sandboxed",
)
