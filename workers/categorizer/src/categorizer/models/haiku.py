from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Literal

import httpx

from categorizer import Secret, Settings, SettingsError

HaikuCode = Literal[
    "haiku_auth",
    "haiku_credits",
    "haiku_bad_request",
    "haiku_timeout",
    "haiku_rate_limited",
    "haiku_5xx",
    "haiku_refusal",
]

_URL = "https://openrouter.ai/api/v1/chat/completions"
_TIMEOUT = 60.0
_MAX_RETRIES = 2
_TOOL_NAME = "submit_categorization"
_RETRYABLE = frozenset({"haiku_timeout", "haiku_rate_limited", "haiku_5xx"})

_LEAN: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["lean", "evidence"],
    "properties": {
        "lean": {"type": "string", "enum": ["yes", "no", "unsure"]},
        "evidence": {"type": "string", "maxLength": 300},
    },
}

_TOOL: dict[str, object] = {
    "type": "function",
    "function": {
        "name": _TOOL_NAME,
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "tags",
                "proposed_categories",
                "safety",
                "content_summary",
                "injection_suspected",
            ],
            "properties": {
                "tags": {
                    "type": "array",
                    "maxItems": 12,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["slug", "evidence"],
                        "properties": {
                            "slug": {"type": "string"},
                            "evidence": {"type": "string", "maxLength": 300},
                        },
                    },
                },
                "proposed_categories": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["slug", "name", "definition", "evidence"],
                        "properties": {
                            "slug": {
                                "type": "string",
                                "pattern": "^[a-z][a-z0-9_]{1,31}$",
                            },
                            "name": {"type": "string"},
                            "definition": {"type": "string", "minLength": 10, "maxLength": 1000},
                            "evidence": {"type": "string", "maxLength": 300},
                        },
                    },
                },
                "safety": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["nsfw", "kid_safe"],
                    "properties": {"nsfw": _LEAN, "kid_safe": _LEAN},
                },
                "content_summary": {"type": "string", "maxLength": 800},
                "injection_suspected": {"type": "boolean"},
            },
        },
    },
}


class HaikuError(Exception):
    def __init__(
        self,
        code: HaikuCode,
        *,
        http_status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.code in _RETRYABLE


class Suggestion:
    __slots__ = ("arguments", "model", "usage")

    def __init__(self, *, arguments: str, model: str, usage: Mapping[str, int]) -> None:
        object.__setattr__(self, "arguments", arguments)
        object.__setattr__(self, "model", model)
        object.__setattr__(self, "usage", dict(usage))

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(name)


def suggest(
    settings: Settings,
    messages: Sequence[Mapping[str, object]],
    *,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> Suggestion:
    if settings.openrouter_model == "":
        raise SettingsError("OPENROUTER_MODEL")
    body = {
        "model": settings.openrouter_model,
        "temperature": 0,
        "max_tokens": 1500,
        "messages": list(messages),
        "tools": [_TOOL],
        "tool_choice": {"type": "function", "function": {"name": _TOOL_NAME}},
        "provider": {"data_collection": "deny", "zdr": True, "require_parameters": True},
    }
    attempt = 0
    with httpx.Client(transport=transport, timeout=_TIMEOUT) as client:
        while True:
            result = _call(client, settings.openrouter_api_key, body)
            if isinstance(result, Suggestion):
                return result
            if not result.retryable or attempt >= _MAX_RETRIES:
                raise result
            sleep(result.retry_after if result.retry_after is not None else 2.0**attempt)
            attempt += 1


def _call(
    client: httpx.Client,
    key: Secret,
    body: Mapping[str, object],
) -> Suggestion | HaikuError:
    try:
        response = client.post(
            _URL,
            headers={"Authorization": f"Bearer {key.reveal()}"},
            json=body,
        )
    except httpx.HTTPError:
        return HaikuError("haiku_timeout")
    if response.status_code != 200:
        return _status_error(response)
    return _parse(response)


def _status_error(response: httpx.Response) -> HaikuError:
    status = response.status_code
    code: HaikuCode
    if status in (401, 403):
        code = "haiku_auth"
    elif status == 402:
        code = "haiku_credits"
    elif status == 408:
        code = "haiku_timeout"
    elif status == 429:
        code = "haiku_rate_limited"
    elif status < 500:
        code = "haiku_bad_request"
    else:
        code = "haiku_5xx"
    return HaikuError(code, http_status=status, retry_after=_retry_after(response))


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after")
    if raw is None:
        return None
    text = raw.strip()
    if re.fullmatch(r"[0-9]+", text) is None:
        return None
    return min(float(text), _TIMEOUT)


def _parse(response: httpx.Response) -> Suggestion | HaikuError:
    try:
        body: object = response.json()
    except ValueError:
        return HaikuError("haiku_refusal")
    if not isinstance(body, dict):
        return HaikuError("haiku_refusal")
    arguments = _arguments(body)
    model = body.get("model")
    if arguments is None or not isinstance(model, str):
        return HaikuError("haiku_refusal")
    return Suggestion(arguments=arguments, model=model, usage=_usage(body.get("usage")))


def _arguments(body: Mapping[str, object]) -> str | None:
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    choice = choices[0]
    if not isinstance(choice, dict) or choice.get("finish_reason") == "content_filter":
        return None
    message = choice.get("message")
    if not isinstance(message, dict):
        return None
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return None
    for call in calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function")
        if not isinstance(function, dict) or function.get("name") != _TOOL_NAME:
            continue
        arguments = function.get("arguments")
        return arguments if isinstance(arguments, str) else None
    return None


def _usage(raw: object) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    return {key: value for key, value in raw.items() if type(key) is str and type(value) is int}


__all__ = ("HaikuCode", "HaikuError", "Suggestion", "suggest")
