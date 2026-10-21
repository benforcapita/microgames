from __future__ import annotations

import multiprocessing
import os
import resource
import signal
import socket
import time
from collections.abc import Callable
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Literal, NamedTuple

ExtractCode = Literal["bundle_path", "extract_limit", "extract_crash", "extract_image"]
_LIMIT_EXITS = frozenset({-signal.SIGKILL, -signal.SIGXCPU})


class ExtractFailed(Exception):
    def __init__(self, code: ExtractCode) -> None:
        super().__init__(code)
        self.code = code


class Limits(NamedTuple):
    as_bytes: int = 768 * 1024 * 1024
    cpu_seconds: int = 20
    open_files: int = 64
    wall_seconds: float = 60.0


DEFAULT_LIMITS = Limits()


class Outcome(NamedTuple):
    code: str | None
    value: object
    pid: int
    exitcode: int


def run_sandboxed(
    work_dir: Path,
    fn: Callable[[Path, object], object],
    payload: object,
    *,
    limits: Limits = DEFAULT_LIMITS,
) -> Outcome:
    ctx = multiprocessing.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_entry, args=(child, str(work_dir), fn, payload, limits))
    proc.start()
    child.close()
    pid = -1 if proc.pid is None else proc.pid
    deadline = time.monotonic() + limits.wall_seconds
    message: object = None
    if parent.poll(max(deadline - time.monotonic(), 0.0)):
        try:
            message = parent.recv()
        except (EOFError, OSError):
            pass
    parent.close()
    proc.join(max(deadline - time.monotonic(), 0.0))
    if proc.is_alive():
        proc.kill()
        proc.join()
    exitcode = -1 if proc.exitcode is None else proc.exitcode
    if isinstance(message, tuple) and len(message) == 2:
        if message[0] == "ok":
            return Outcome(code=None, value=message[1], pid=pid, exitcode=exitcode)
        if message[0] == "fail" and isinstance(message[1], str):
            return Outcome(code=message[1], value=None, pid=pid, exitcode=exitcode)
    code = "extract_limit" if exitcode in _LIMIT_EXITS else "extract_crash"
    return Outcome(code=code, value=None, pid=pid, exitcode=exitcode)


def _entry(
    conn: Connection,
    work_dir: str,
    fn: Callable[[Path, object], object],
    payload: object,
    limits: Limits,
) -> None:
    try:
        os.chdir(work_dir)
        socket.socket = _DeniedSocket
        socket.socketpair = _DeniedSocket
        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds,) * 2)
        resource.setrlimit(resource.RLIMIT_AS, (limits.as_bytes,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (limits.open_files,) * 2)
        conn.send(("ok", fn(Path(work_dir), payload)))
    except ExtractFailed as err:
        _send(conn, ("fail", err.code))
    except MemoryError:
        _send(conn, ("fail", "extract_limit"))
    except BaseException:
        _send(conn, ("fail", "extract_crash"))
    finally:
        conn.close()


def _send(conn: Connection, message: tuple[str, object]) -> None:
    try:
        conn.send(message)
    except OSError:
        return


class _DeniedSocket(socket.socket):
    def __init__(self, *_args: object, **_kwargs: object) -> None:
        raise OSError("network disabled")
