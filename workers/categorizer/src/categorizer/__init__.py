from __future__ import annotations

import base64
import json
import os
import re
import secrets
import signal
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, NoReturn, Protocol, TextIO
from urllib.parse import parse_qs, unquote, urlsplit

SETTING_ORDER: tuple[str, ...] = (
    "CATEGORIZER_DATABASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "TYPESAFE_API_KEY",
    "JEV_MODEL",
    "CATEGORIZER_FETCH_URL",
    "CATEGORIZER_FETCH_SECRET",
    "CATEGORIZER_MAX_RUNS",
    "CATEGORIZER_MAX_SECONDS",
)

LOG_FIELDS: tuple[str, ...] = (
    "ts",
    "level",
    "run_id",
    "game_id",
    "stage",
    "error_code",
    "provider",
    "http_status",
    "attempt",
)

_DEFAULT_MAX_RUNS = 10
_DEFAULT_MAX_SECONDS = 600
_DB_USER = r"^meshgrounds_categorizer(?:\.[a-z0-9]{20})?$"
_OPENROUTER_MODEL = r"^[a-z0-9-]+/[a-z0-9.:-]+$"
_BOOT_STAGE = "boot"
_DRAIN_STAGE = "drain"
_LEVEL = "error"
_REDACTED = "redacted"
_HANDLER_FAILED = "handler_failed"
_WORKLOAD_FAILED = "workload_failed"
_TS_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
_IPV4 = (
    r"(?<![0-9])(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)"
    r"(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}(?![0-9])"
)
_IPV6 = r"(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}"
_SOURCE_EMAIL = r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
_URL_PASSWORD = r"://[^/\s:@]+:[^/\s@]+@"
_PEM_MARKERS = (
    "-----BEGIN " + "RSA PRIVATE KEY-----",
    "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
)
_SKIP_DIRS = {"__pycache__"}


class SettingsError(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self._key = key

    @property
    def key(self) -> str:
        return self._key

    def __str__(self) -> str:
        return self._key


class Secret:
    __slots__ = ("_value",)
    __hash__ = None

    def __init__(self, value: str) -> None:
        object.__setattr__(self, "_value", value)

    def reveal(self) -> str:
        value = object.__getattribute__(self, "_value")
        if type(value) is not str:
            raise TypeError("Secret")
        return value

    def __str__(self) -> str:
        return "Secret"

    def __repr__(self) -> str:
        return "Secret"

    def __format__(self, format_spec: str) -> str:
        return "Secret"

    def __reduce__(self) -> NoReturn:
        raise TypeError("Secret")

    def __eq__(self, other: object) -> bool:
        if type(other) is not Secret:
            return NotImplemented
        return secrets.compare_digest(self.reveal(), other.reveal())

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class Limits:
    __slots__ = ("max_runs", "max_seconds")

    def __init__(self, *, max_runs: int, max_seconds: int) -> None:
        object.__setattr__(self, "max_runs", max_runs)
        object.__setattr__(self, "max_seconds", max_seconds)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class Settings:
    __slots__ = (
        "database_url",
        "fetch_secret",
        "fetch_url",
        "jev_model",
        "limits",
        "openrouter_api_key",
        "openrouter_model",
        "typesafe_api_key",
    )

    def __init__(
        self,
        *,
        database_url: Secret,
        openrouter_api_key: Secret,
        openrouter_model: str,
        typesafe_api_key: Secret,
        jev_model: str,
        fetch_url: str,
        fetch_secret: Secret,
        limits: Limits,
    ) -> None:
        object.__setattr__(self, "database_url", database_url)
        object.__setattr__(self, "openrouter_api_key", openrouter_api_key)
        object.__setattr__(self, "openrouter_model", openrouter_model)
        object.__setattr__(self, "typesafe_api_key", typesafe_api_key)
        object.__setattr__(self, "jev_model", jev_model)
        object.__setattr__(self, "fetch_url", fetch_url)
        object.__setattr__(self, "fetch_secret", fetch_secret)
        object.__setattr__(self, "limits", limits)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class ErrorEvent:
    __slots__ = LOG_FIELDS[2:]

    def __init__(
        self,
        *,
        run_id: str | None = None,
        game_id: str | None = None,
        stage: str | None = None,
        error_code: str | None = None,
        provider: str | None = None,
        http_status: int | None = None,
        attempt: int | None = None,
    ) -> None:
        values: dict[str, str | int | None] = {
            "run_id": run_id,
            "game_id": game_id,
            "stage": stage,
            "error_code": error_code,
            "provider": provider,
            "http_status": http_status,
            "attempt": attempt,
        }
        for name, value in values.items():
            _reject_bad_field(name, value)
            object.__setattr__(self, name, value)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


class Clock(Protocol):
    def monotonic(self) -> float: ...

    def now(self) -> datetime: ...


class _SystemClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def now(self) -> datetime:
        return datetime.now(UTC)


class Stop:
    __slots__ = ("_requested",)

    def __init__(self) -> None:
        self._requested = False

    def request(self) -> None:
        self._requested = True

    def requested(self) -> bool:
        return self._requested


class Queue[T](Protocol):
    def claim(self) -> T | None: ...


class FakeQueue[T]:
    def __init__(self, claims: Sequence[T]) -> None:
        self._claims = list(claims)
        self._calls = 0

    def claim(self) -> T | None:
        self._calls += 1
        if not self._claims:
            return None
        return self._claims.pop(0)

    @property
    def claim_calls(self) -> int:
        return self._calls


class Workload[T]:
    __slots__ = ("handle", "queue")

    def __init__(self, *, queue: Queue[T], handle: Callable[[T], None]) -> None:
        object.__setattr__(self, "queue", queue)
        object.__setattr__(self, "handle", handle)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


SignalBind = Callable[[Stop], Callable[[], None]]


class Deps[T]:
    __slots__ = ("bind_signal", "clock", "stop", "stream", "workload")

    def __init__(
        self,
        *,
        workload: Callable[[Settings], Workload[T]],
        clock: Clock,
        stop: Stop,
        stream: TextIO,
        bind_signal: SignalBind,
    ) -> None:
        object.__setattr__(self, "workload", workload)
        object.__setattr__(self, "clock", clock)
        object.__setattr__(self, "stop", stop)
        object.__setattr__(self, "stream", stream)
        object.__setattr__(self, "bind_signal", bind_signal)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


def load_settings(environ: Mapping[str, str]) -> Settings:
    database_url = _database(environ.get("CATEGORIZER_DATABASE_URL"))
    openrouter_api_key = _api_key(environ.get("OPENROUTER_API_KEY"), "OPENROUTER_API_KEY")
    openrouter_model = _openrouter_model(environ.get("OPENROUTER_MODEL"))
    typesafe_api_key = _api_key(environ.get("TYPESAFE_API_KEY"), "TYPESAFE_API_KEY")
    jev_model = _jev_model(environ.get("JEV_MODEL"))
    fetch_url = _fetch_url(environ.get("CATEGORIZER_FETCH_URL"))
    fetch_secret = _fetch_secret(environ.get("CATEGORIZER_FETCH_SECRET"))
    max_runs = _budget(
        environ.get("CATEGORIZER_MAX_RUNS"),
        "CATEGORIZER_MAX_RUNS",
        _DEFAULT_MAX_RUNS,
        1,
        50,
    )
    max_seconds = _budget(
        environ.get("CATEGORIZER_MAX_SECONDS"),
        "CATEGORIZER_MAX_SECONDS",
        _DEFAULT_MAX_SECONDS,
        60,
        1800,
    )
    return Settings(
        database_url=database_url,
        openrouter_api_key=openrouter_api_key,
        openrouter_model=openrouter_model,
        typesafe_api_key=typesafe_api_key,
        jev_model=jev_model,
        fetch_url=fetch_url,
        fetch_secret=fetch_secret,
        limits=Limits(max_runs=max_runs, max_seconds=max_seconds),
    )


def emit_error(event: ErrorEvent, *, clock: Clock, stream: TextIO) -> str:
    moment = clock.now().astimezone(UTC)
    payload: dict[str, str | int] = {"ts": moment.strftime(_TS_FORMAT), "level": _LEVEL}
    leaked = False
    for name in LOG_FIELDS[2:]:
        value = getattr(event, name)
        if value is None:
            continue
        if isinstance(value, str) and _leaks(value):
            leaked = True
            break
        payload[name] = value
    if leaked:
        payload = {"ts": payload["ts"], "level": _LEVEL, "error_code": _REDACTED}
    line = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
    stream.write(line)
    return line


def drain[T](
    queue: Queue[T],
    limits: Limits,
    *,
    clock: Clock,
    stop: Stop,
    handle: Callable[[T], None],
) -> Literal[0]:
    taken = 0
    started = clock.monotonic()
    while True:
        if stop.requested():
            return 0
        if taken >= limits.max_runs:
            return 0
        if clock.monotonic() - started >= limits.max_seconds:
            return 0
        item = queue.claim()
        if item is None:
            return 0
        taken += 1
        handle(item)


def bind_sigterm(stop: Stop) -> Callable[[], None]:
    previous = signal.getsignal(signal.SIGTERM)

    def handler(_signum: int, _frame: object) -> None:
        stop.request()

    signal.signal(signal.SIGTERM, handler)

    def restore() -> None:
        signal.signal(signal.SIGTERM, previous)

    return restore


def process_deps() -> Deps[object]:
    return Deps(
        workload=_idle_workload,
        clock=_SystemClock(),
        stop=Stop(),
        stream=sys.stdout,
        bind_signal=bind_sigterm,
    )


def main[T](environ: Mapping[str, str], deps: Deps[T]) -> Literal[0, 1]:
    try:
        settings = load_settings(environ)
    except SettingsError as err:
        _emit_quiet(ErrorEvent(stage=_BOOT_STAGE, error_code=err.key), clock=deps.clock, stream=deps.stream)
        return 1
    restore = deps.bind_signal(deps.stop)
    try:
        try:
            prepared = deps.workload(settings)
        except Exception:
            _emit_quiet(
                ErrorEvent(stage=_BOOT_STAGE, error_code=_WORKLOAD_FAILED),
                clock=deps.clock,
                stream=deps.stream,
            )
            return 1
        try:
            return drain(
                prepared.queue,
                settings.limits,
                clock=deps.clock,
                stop=deps.stop,
                handle=prepared.handle,
            )
        except Exception:
            _emit_quiet(
                ErrorEvent(stage=_DRAIN_STAGE, error_code=_HANDLER_FAILED),
                clock=deps.clock,
                stream=deps.stream,
            )
            return 1
    finally:
        restore()


def scan_repo(root: Path | None = None, stream: TextIO | None = None) -> Literal[0, 1]:
    project = Path(__file__).resolve().parents[2]
    target = project if root is None else root
    out = sys.stdout if stream is None else stream
    rules = (
        ("ipv4", re.compile(_IPV4)),
        ("ipv6", re.compile(_IPV6)),
        ("email", re.compile(_SOURCE_EMAIL)),
        ("url_password", re.compile(_URL_PASSWORD)),
        ("private_key", re.compile("|".join(re.escape(marker) for marker in _PEM_MARKERS))),
    )
    found = False
    for path in _files(target):
        found = _scan_file(path, rules, out) or found
    return 1 if found else 0


def _present(raw: str | None, key: str) -> str:
    if raw is None or raw == "" or any(character.isspace() for character in raw):
        raise SettingsError(key)
    return raw


def _database(raw: str | None) -> Secret:
    text = _present(raw, "CATEGORIZER_DATABASE_URL")
    parts = urlsplit(text)
    user = unquote(parts.username) if parts.username is not None else ""
    modes = parse_qs(parts.query, keep_blank_values=True).get("sslmode")
    if (
        parts.scheme not in {"postgres", "postgresql"}
        or parts.fragment
        or re.fullmatch(_DB_USER, user) is None
        or not parts.hostname
        or parts.path in {"", "/"}
        or modes != ["require"]
    ):
        raise SettingsError("CATEGORIZER_DATABASE_URL")
    return Secret(text)


def _api_key(raw: str | None, key: str) -> Secret:
    text = _present(raw, key)
    if not text.isascii():
        raise SettingsError(key)
    return Secret(text)


def _openrouter_model(raw: str | None) -> str:
    text = _present(raw, "OPENROUTER_MODEL")
    vendor, _slash, _name = text.partition("/")
    if re.fullmatch(_OPENROUTER_MODEL, text) is None or vendor == "openrouter":
        raise SettingsError("OPENROUTER_MODEL")
    return text


def _jev_model(raw: str | None) -> str:
    text = _present(raw, "JEV_MODEL")
    if text.casefold() == "jev-latest":
        raise SettingsError("JEV_MODEL")
    return text


def _fetch_url(raw: str | None) -> str:
    text = _present(raw, "CATEGORIZER_FETCH_URL")
    parts = urlsplit(text)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.fragment
    ):
        raise SettingsError("CATEGORIZER_FETCH_URL")
    return text


def _fetch_secret(raw: str | None) -> Secret:
    text = _present(raw, "CATEGORIZER_FETCH_SECRET")
    if re.fullmatch(r"[A-Za-z0-9_-]*={0,2}", text) is None:
        raise SettingsError("CATEGORIZER_FETCH_SECRET")
    body = text.rstrip("=")
    padded = body + ("=" * ((4 - len(body) % 4) % 4))
    try:
        decoded = base64.urlsafe_b64decode(padded)
    except Exception:
        raise SettingsError("CATEGORIZER_FETCH_SECRET") from None
    if len(decoded) < 32:
        raise SettingsError("CATEGORIZER_FETCH_SECRET")
    return Secret(text)


def _budget(raw: str | None, key: str, default: int, low: int, high: int) -> int:
    if raw is None:
        return default
    if any(character.isspace() for character in raw) or re.fullmatch(r"[1-9][0-9]*", raw) is None:
        raise SettingsError(key)
    value = int(raw)
    if value < low or value > high:
        raise SettingsError(key)
    return value


def _reject_bad_field(name: str, value: object) -> None:
    if value is None:
        return
    if name in {"http_status", "attempt"}:
        if type(value) is not int:
            raise TypeError(name)
        return
    if type(value) is not str:
        raise TypeError(name)


def _leaks(value: str) -> bool:
    if "@" in value:
        return True
    if re.search(_IPV4, value) is not None:
        return True
    if re.search(_IPV6, value) is not None:
        return True
    return (":" * 2) in value


def _emit_quiet(event: ErrorEvent, *, clock: Clock, stream: TextIO) -> None:
    try:
        emit_error(event, clock=clock, stream=stream)
    except Exception:
        return


def _ignore_claim(_claim: object) -> None:
    return None


def _idle_workload(_settings: Settings) -> Workload[object]:
    return Workload(queue=FakeQueue(()), handle=_ignore_claim)


def _files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if not name.startswith(".") and name not in _SKIP_DIRS]
        for name in filenames:
            found.append(Path(dirpath) / name)
    return found


def _scan_file(
    path: Path,
    rules: tuple[tuple[str, re.Pattern[str]], ...],
    out: TextIO,
) -> bool:
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return False
    hit = False
    for name, pattern in rules:
        if pattern.search(text):
            out.write(f"{name}\t{path}\n")
            hit = True
    return hit


__all__ = (
    "LOG_FIELDS",
    "SETTING_ORDER",
    "Clock",
    "Deps",
    "ErrorEvent",
    "FakeQueue",
    "Limits",
    "Queue",
    "Secret",
    "Settings",
    "SettingsError",
    "SignalBind",
    "Stop",
    "Workload",
    "bind_sigterm",
    "drain",
    "emit_error",
    "load_settings",
    "main",
    "process_deps",
    "scan_repo",
)
