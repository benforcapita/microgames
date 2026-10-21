from __future__ import annotations

import io
import json
import logging
from collections.abc import Sequence

import httpx
import pytest

from categorizer import ErrorEvent, Limits, Secret, Settings, SettingsError, emit_error
from categorizer.models import HaikuError, suggest
from support import ManualClock

KEY = "sk-or-test-PLACEHOLDER"
MODEL = "vendor/test-model"
URL = "https://openrouter.ai/api/v1/chat/completions"
MESSAGES = ({"role": "user", "content": "hello"},)


def _settings(model: str = MODEL) -> Settings:
    return Settings(
        database_url=Secret("placeholder"),
        openrouter_api_key=Secret(KEY),
        openrouter_model=model,
        typesafe_api_key=Secret("placeholder"),
        jev_model="jev-1.13.0",
        fetch_url="https://placeholder.invalid",
        fetch_secret=Secret("placeholder"),
        limits=Limits(max_runs=1, max_seconds=60),
    )


def _ok_body() -> dict[str, object]:
    return {
        "id": "gen-1",
        "model": "vendor/returned-model",
        "choices": [
            {
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "submit_categorization",
                                "arguments": '{"tags": []}',
                            },
                        }
                    ],
                },
            }
        ],
        "usage": {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33},
    }


def _refusal_bodies() -> list[dict[str, object]]:
    missing = _ok_body()
    del missing["choices"][0]["message"]["tool_calls"]
    wrong_name = _ok_body()
    wrong_name["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "other"
    bad_arguments = _ok_body()
    bad_arguments["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = 7
    filtered = _ok_body()
    filtered["choices"][0]["finish_reason"] = "content_filter"
    empty = _ok_body()
    empty["choices"] = []
    return [missing, wrong_name, bad_arguments, filtered, empty]


class Api:
    def __init__(self, steps: Sequence[httpx.Response | Exception]) -> None:
        self._steps = list(steps)
        self.requests: list[httpx.Request] = []
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._steps:
            return httpx.Response(500)
        step = self._steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def _errors(statuses: Sequence[int]) -> list[httpx.Response]:
    return [httpx.Response(status) for status in statuses]


def test_request_is_the_pinned_openrouter_call() -> None:
    api = Api([httpx.Response(200, json=_ok_body())])
    result = suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
    [request] = api.requests
    assert request.method == "POST"
    assert request.url == URL
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.extensions["timeout"]["read"] == 60.0
    body = json.loads(request.content)
    assert result.arguments == '{"tags": []}'
    assert body["model"] == MODEL
    assert body["temperature"] == 0
    assert body["max_tokens"] == 1500
    assert body["messages"] == list(MESSAGES)
    assert body["provider"] == {
        "data_collection": "deny",
        "zdr": True,
        "require_parameters": True,
    }
    assert body["tool_choice"] == {
        "type": "function",
        "function": {"name": "submit_categorization"},
    }
    [tool] = body["tools"]
    assert tool["type"] == "function"
    assert tool["function"]["name"] == "submit_categorization"
    parameters = tool["function"]["parameters"]
    assert parameters["type"] == "object"
    assert parameters["additionalProperties"] is False
    assert set(parameters["required"]) == {
        "tags",
        "proposed_categories",
        "safety",
        "content_summary",
        "injection_suspected",
    }


def test_model_comes_only_from_settings() -> None:
    api = Api([httpx.Response(200, json=_ok_body())])
    suggest(
        _settings(model="other/model-x"), MESSAGES, transport=api.transport, sleep=lambda _s: None
    )
    assert json.loads(api.requests[0].content)["model"] == "other/model-x"


def test_missing_model_fails_closed_without_a_request() -> None:
    api = Api([httpx.Response(200, json=_ok_body())])
    with pytest.raises(SettingsError) as raised:
        suggest(_settings(model=""), MESSAGES, transport=api.transport, sleep=lambda _s: None)
    assert raised.value.key == "OPENROUTER_MODEL"
    assert api.requests == []


def test_success_returns_response_model_usage_and_arguments() -> None:
    api = Api([httpx.Response(200, json=_ok_body())])
    result = suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
    assert result.model == "vendor/returned-model"
    assert result.usage == {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33}
    assert result.arguments == '{"tags": []}'


@pytest.mark.parametrize(
    ("status", "code", "attempts"),
    [
        (401, "haiku_auth", 1),
        (403, "haiku_auth", 1),
        (402, "haiku_credits", 1),
        (400, "haiku_bad_request", 1),
        (404, "haiku_bad_request", 1),
        (422, "haiku_bad_request", 1),
        (408, "haiku_timeout", 3),
        (429, "haiku_rate_limited", 3),
        (500, "haiku_5xx", 3),
        (503, "haiku_5xx", 3),
    ],
)
def test_status_maps_to_error_code_and_retry_count(status: int, code: str, attempts: int) -> None:
    api = Api(_errors([status] * 3))
    sleeps: list[float] = []
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert raised.value.code == code
    assert raised.value.http_status == status
    assert raised.value.retryable is (attempts == 3)
    assert len(api.requests) == attempts
    assert len(sleeps) == attempts - 1


def test_retry_after_header_sets_the_delay() -> None:
    api = Api(
        [
            httpx.Response(429, headers={"Retry-After": "7"}),
            httpx.Response(200, json=_ok_body()),
        ]
    )
    sleeps: list[float] = []
    result = suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert result.model == "vendor/returned-model"
    assert sleeps == [7.0]


def test_backoff_doubles_without_retry_after() -> None:
    api = Api(_errors([500, 500]) + [httpx.Response(200, json=_ok_body())])
    sleeps: list[float] = []
    suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert sleeps == [1.0, 2.0]


@pytest.mark.parametrize(
    "header",
    ["７", "٧", "Wed, 21 Oct 2026 07:28:00 GMT", "soon"],
    ids=["fullwidth", "arabic_indic", "http_date", "garbage"],
)
def test_non_delta_seconds_retry_after_falls_back_to_backoff(header: str) -> None:
    api = Api(
        [
            httpx.Response(429, headers=[(b"retry-after", header.encode())]),
            httpx.Response(200, json=_ok_body()),
        ]
    )
    sleeps: list[float] = []
    result = suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert result.arguments == '{"tags": []}'
    assert sleeps == [1.0]


@pytest.mark.parametrize("header", ["-5", "-1.5"], ids=["negative", "negative_float"])
def test_negative_retry_after_is_treated_as_missing(header: str) -> None:
    api = Api([httpx.Response(429, headers={"Retry-After": header}) for _ in range(3)])
    sleeps: list[float] = []
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert raised.value.code == "haiku_rate_limited"
    assert raised.value.retry_after is None
    assert sleeps == [1.0, 2.0]


def test_malformed_retry_after_keeps_the_status_error_code() -> None:
    api = Api([httpx.Response(400, headers=[(b"retry-after", "٧".encode())])])
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
    assert raised.value.code == "haiku_bad_request"
    assert raised.value.http_status == 400
    assert raised.value.retry_after is None


@pytest.mark.parametrize("header", ["86400", "9" * 400], ids=["day_seconds", "huge"])
def test_large_retry_after_is_capped_at_sixty_seconds(header: str) -> None:
    api = Api(
        [
            httpx.Response(429, headers={"Retry-After": header}),
            httpx.Response(200, json=_ok_body()),
        ]
    )
    sleeps: list[float] = []
    result = suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert result.arguments == '{"tags": []}'
    assert sleeps == [60.0]


@pytest.mark.parametrize("failure", [httpx.TimeoutException("slow"), httpx.ConnectError("refused")])
def test_transport_failures_map_to_haiku_timeout_and_retry(failure: Exception) -> None:
    api = Api([failure, failure, failure])
    sleeps: list[float] = []
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert raised.value.code == "haiku_timeout"
    assert len(api.requests) == 3
    assert sleeps == [1.0, 2.0]


@pytest.mark.parametrize(
    "body", _refusal_bodies(), ids=["missing", "wrong_name", "bad_args", "filtered", "empty"]
)
def test_no_usable_tool_call_is_refusal_without_retry(body: dict[str, object]) -> None:
    api = Api([httpx.Response(200, json=body)])
    sleeps: list[float] = []
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert raised.value.code == "haiku_refusal"
    assert raised.value.retryable is False
    assert len(api.requests) == 1
    assert sleeps == []


@pytest.mark.parametrize("body", ["<html>oops</html>", ""], ids=["html", "empty"])
def test_non_json_200_body_is_refusal_without_retry(body: str) -> None:
    api = Api([httpx.Response(200, content=body)])
    sleeps: list[float] = []
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=sleeps.append)
    assert raised.value.code == "haiku_refusal"
    assert raised.value.retryable is False
    assert len(api.requests) == 1
    assert sleeps == []


def test_key_never_appears_in_errors_or_log_output() -> None:
    refusal = _refusal_bodies()[0]
    scenarios: list[list[httpx.Response | Exception]] = [
        _errors([401]),
        _errors([402]),
        _errors([400]),
        _errors([408] * 3),
        [httpx.Response(429, headers={"Retry-After": "3"})] + _errors([429, 429]),
        _errors([500] * 3),
        [httpx.TimeoutException("slow")] * 3,
        [httpx.Response(200, json=refusal)],
    ]
    for steps in scenarios:
        api = Api(steps)
        buf = io.StringIO()
        with pytest.raises(HaikuError) as raised:
            suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
        err = raised.value
        emit_error(
            ErrorEvent(
                error_code=err.code,
                http_status=err.http_status,
                provider="openrouter",
                attempt=len(api.requests),
            ),
            clock=ManualClock(),
            stream=buf,
        )
        assert KEY not in str(err)
        assert KEY not in repr(err)
        assert KEY not in buf.getvalue()


def _assert_key_unreachable_from(err: HaikuError) -> None:
    seen: set[int] = set()
    stack: list[BaseException | None] = [err]
    while stack:
        node = stack.pop()
        if node is None or id(node) in seen:
            continue
        seen.add(id(node))
        assert KEY not in str(node)
        assert KEY not in repr(node)
        assert not isinstance(node, httpx.HTTPError)
        request = getattr(node, "request", None)
        if isinstance(request, httpx.Request):
            assert KEY not in request.headers.get("authorization", "")
        stack.extend((node.__cause__, node.__context__))


@pytest.mark.parametrize(
    "failure",
    [httpx.ConnectError("refused"), httpx.ReadTimeout("slow")],
    ids=["connect_error", "read_timeout"],
)
def test_transport_failures_raise_an_unchained_haiku_error(failure: Exception) -> None:
    api = Api([failure, failure, failure])
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
    assert raised.value.code == "haiku_timeout"
    _assert_key_unreachable_from(raised.value)


def test_status_errors_raise_an_unchained_haiku_error() -> None:
    api = Api(_errors([401]))
    with pytest.raises(HaikuError) as raised:
        suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
    assert raised.value.code == "haiku_auth"
    _assert_key_unreachable_from(raised.value)


@pytest.mark.parametrize(
    ("steps", "code"),
    [
        ([httpx.Response(200, json=_ok_body())], None),
        (_errors([401]), "haiku_auth"),
        ([httpx.Response(429), httpx.Response(200, json=_ok_body())], None),
        ([httpx.ConnectError("refused"), httpx.Response(200, json=_ok_body())], None),
    ],
    ids=["success", "non_retryable_error", "rate_limit_retry", "transport_retry"],
)
def test_key_never_appears_in_logs_stdout_or_stderr(
    steps: list[httpx.Response | Exception],
    code: str | None,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    api = Api(steps)
    with caplog.at_level(logging.DEBUG):
        if code is None:
            suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
        else:
            with pytest.raises(HaikuError) as raised:
                suggest(_settings(), MESSAGES, transport=api.transport, sleep=lambda _s: None)
            assert raised.value.code == code
    captured = capsys.readouterr()
    assert KEY not in caplog.text
    assert KEY not in captured.out
    assert KEY not in captured.err
