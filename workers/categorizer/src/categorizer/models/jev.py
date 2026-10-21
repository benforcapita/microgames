from __future__ import annotations

import math
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

import httpx2
from typesafe_sdk import (
    JSONContent,
    Noul,
    Question,
    RetryPolicy,
    TypeSafeAPIConnectionError,
    TypeSafeAPIError,
    TypeSafeAPIResponseValidationError,
    TypeSafeAPITimeoutError,
    TypeSafeClient,
    Usage,
)

from categorizer import Settings
from categorizer.decide import Category

JevCode = Literal[
    "jev_auth", "jev_bad_request", "jev_rate_limited", "jev_5xx",
    "jev_timeout", "jev_connection", "jev_missing_answer",
]

_TIMEOUT = 30.0
_MAX_RETRIES = 2
_MAX_DELAY = 60.0
_CHUNK = 8
_SAFETY = ("nsfw", "kid_safe")
_REQUEST_ID = "x-typesafe-request-id"
_STATUS: dict[int, JevCode] = {
    400: "jev_bad_request", 401: "jev_auth", 403: "jev_bad_request",
    404: "jev_bad_request", 413: "jev_bad_request", 415: "jev_bad_request",
    422: "jev_bad_request", 429: "jev_rate_limited",
}
_RETRYABLE = frozenset({"jev_rate_limited", "jev_5xx", "jev_timeout", "jev_connection"})


class JevError(Exception):
    def __init__(
        self, code: JevCode, *, http_status: int | None = None,
        retry_after: float | None = None, request_id: str | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.retry_after = retry_after
        self.request_id = request_id

    @property
    def retryable(self) -> bool:
        return self.code in _RETRYABLE


@dataclass(frozen=True)
class JevCall:
    answers: Mapping[str, float]
    model: str
    usage: Mapping[str, int]
    request_id: str | None


@dataclass(frozen=True)
class JevResult:
    answers: Mapping[str, float | None]
    model: str
    usage: Mapping[str, int]
    request_ids: tuple[str, ...]


class AsksJev(Protocol):
    def ask(
        self, state: JSONContent, questions: Mapping[str, Question]
    ) -> JevCall: ...


class FakeJev:
    def __init__(
        self, answers: Mapping[str, float] | None = None, *,
        model: str = "fake-jev", usage: Mapping[str, int] | None = None,
    ) -> None:
        self._answers = dict(answers or {})
        self._model = model
        self._usage = dict(usage or {})
        self.states: list[JSONContent] = []
        self.questions: list[Mapping[str, Question]] = []

    def ask(self, state: JSONContent, questions: Mapping[str, Question]) -> JevCall:
        self.states.append(state)
        self.questions.append(questions)
        return JevCall(
            answers={n: self._answers[n] for n in questions if n in self._answers},
            model=self._model,
            usage=dict(self._usage),
            request_id=f"fake-{len(self.questions)}",
        )


class TypeSafeJev:
    def __init__(
        self, settings: Settings, *,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._model = settings.jev_model
        self._sleep = sleep
        self._client = TypeSafeClient(
            api_key=settings.typesafe_api_key.reveal(),
            model=self._model,
            timeout=_TIMEOUT,
            transport=transport,
            retry=RetryPolicy(max_retries=0),
        )

    def ask(self, state: JSONContent, questions: Mapping[str, Question]) -> JevCall:
        attempt = 0
        while True:
            result = _call(self._client, self._model, state, questions)
            if isinstance(result, JevCall):
                return result
            if not result.retryable or attempt >= _MAX_RETRIES:
                raise result
            self._sleep(
                result.retry_after if result.retry_after is not None else 2.0**attempt
            )
            attempt += 1


def judge(
    asker: AsksJev,
    state: JSONContent,
    categories: Sequence[Category],
    suggested: Sequence[str],
) -> JevResult:
    answers: dict[str, float | None] = {}
    usage: dict[str, int] = {}
    request_ids: list[str] = []
    model = ""
    calls = 0
    asked = _plan(categories, suggested)
    for start in range(0, len(asked), _CHUNK):
        chunk = asked[start : start + _CHUNK]
        call = asker.ask(state, {f"t_{cat.slug}": _question(cat) for cat in chunk})
        calls += 1
        model = model or call.model
        for key, value in call.usage.items():
            usage[key] = usage.get(key, 0) + value
        if call.request_id is not None:
            request_ids.append(call.request_id)
        for cat in chunk:
            answers[cat.slug] = call.answers.get(f"t_{cat.slug}")
    return JevResult(
        answers=answers,
        model=model,
        usage={**usage, "calls": calls},
        request_ids=tuple(request_ids),
    )


def _plan(categories: Sequence[Category], suggested: Sequence[str]) -> list[Category]:
    by_slug = {cat.slug: cat for cat in categories}
    slugs = [slug for slug in _SAFETY if slug in by_slug]
    for slug in suggested:
        if slug in by_slug and slug not in slugs:
            slugs.append(slug)
    return [by_slug[slug] for slug in slugs]


def _question(cat: Category) -> Noul:
    return Noul(
        instructions=f"This game fits the category '{cat.name}'.",
        criteria={
            "true": cat.definition,
            "false": f"The game does not meet: {cat.definition}",
        },
    )


def _call(
    client: TypeSafeClient,
    model: str,
    state: JSONContent,
    questions: Mapping[str, Question],
) -> JevCall | JevError:
    try:
        response = client.system_one(state, questions, model=model, timeout=_TIMEOUT)
    except TypeSafeAPITimeoutError:
        return JevError("jev_timeout")
    except TypeSafeAPIConnectionError:
        return JevError("jev_connection")
    except TypeSafeAPIResponseValidationError as error:
        return JevCall(answers={}, model="", usage={}, request_id=error.request_id)
    except TypeSafeAPIError as error:
        return _mapped(error)
    return JevCall(
        answers={
            name: answer.noul
            for name, answer in response.nouls.items()
            if 0 <= answer.noul <= 1
        },
        model=response.model,
        usage=_usage(response.usage),
        request_id=response.raw_http_response.headers.get(_REQUEST_ID),
    )


def _mapped(error: TypeSafeAPIError) -> JevError:
    status = error.status
    code = _STATUS.get(status, "jev_5xx" if status >= 500 else "jev_bad_request")
    return JevError(
        code,
        http_status=status,
        retry_after=_retry_after(error),
        request_id=error.request_id,
    )


def _retry_after(error: TypeSafeAPIError) -> float | None:
    ms = getattr(error, "retry_after_ms", None)
    if type(ms) in (int, float) and math.isfinite(ms) and ms >= 0:
        return min(ms / 1000, _MAX_DELAY)
    raw = error.headers.get("retry-after")
    if raw is not None and re.fullmatch(r"[0-9]+", raw.strip()) is not None:
        return min(float(raw), _MAX_DELAY)
    return None


def _usage(usage: Usage) -> dict[str, int]:
    return {
        key: value
        for key in ("input_tokens", "output_tokens")
        if type(value := getattr(usage, key)) is int
    }
