from __future__ import annotations

import base64
import io
import socket
import time
from datetime import UTC, datetime
from pathlib import Path

from categorizer import Deps, FakeQueue, Settings, Stop, Workload, main


class ManualClock:
    def __init__(self, monotonic_at: float = 0.0) -> None:
        self._mono = monotonic_at
        self._now = datetime(2026, 1, 1, tzinfo=UTC)

    def monotonic(self) -> float:
        return self._mono

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._mono += seconds


def fetch_secret() -> str:
    return base64.urlsafe_b64encode(b"a" * 32).decode("ascii").rstrip("=")


def valid_environ() -> dict[str, str]:
    return {
        "CATEGORIZER_DATABASE_URL": (
            "postgresql://meshgrounds_categorizer@localhost/app?sslmode=require"
        ),
        "OPENROUTER_API_KEY": "openrouter-test-key",
        "OPENROUTER_MODEL": "example/test-model",
        "TYPESAFE_API_KEY": "typesafe-test-key",
        "JEV_MODEL": "jev-1.13.0",
        "CATEGORIZER_FETCH_URL": "https://fetch.example/hook",
        "CATEGORIZER_FETCH_SECRET": fetch_secret(),
        "CATEGORIZER_MAX_RUNS": "10",
        "CATEGORIZER_MAX_SECONDS": "600",
    }


def boot(
    env: dict[str, str],
    *,
    queue: object | None = None,
    clock: object | None = None,
    stop: Stop | None = None,
    bind_signal: object | None = None,
    workload: object | None = None,
) -> tuple[int, str, object, list[object]]:
    buf = io.StringIO()
    owned: object = FakeQueue(()) if queue is None else queue
    handled: list[object] = []

    def default_workload(_settings: Settings) -> Workload[object]:
        return Workload(queue=owned, handle=handled.append)

    deps = Deps(
        workload=workload if workload is not None else default_workload,
        clock=clock if clock is not None else ManualClock(),
        stop=stop if stop is not None else Stop(),
        stream=buf,
        bind_signal=bind_signal if bind_signal is not None else (lambda _stop: (lambda: None)),
    )
    code = main(dict(env), deps)
    return code, buf.getvalue(), owned, handled


def echo(_work_dir: Path, payload: object) -> object:
    return payload


def explode(_work_dir: Path, _payload: object) -> str:
    raise RuntimeError("boom")


def burn_cpu(_work_dir: Path, _payload: object) -> str:
    ticks = 0
    while True:
        ticks += 1
    return str(ticks)


def eat_memory(work_dir: Path, _payload: object) -> str:
    chunks: list[bytearray] = []
    remaining = 1_500 * 1024 * 1024
    step = 64 * 1024 * 1024
    while remaining > 0:
        chunks.append(bytearray(step))
        remaining -= step
    (work_dir / "survived").write_text("x", encoding="ascii")
    return str(len(chunks))


def sleep_seconds(_work_dir: Path, payload: object) -> str:
    time.sleep(float(payload))
    return "slept"


def open_socket(_work_dir: Path, _payload: object) -> str:
    sock = socket.socket()
    sock.close()
    return "connected"
