from __future__ import annotations

import io
import json

import pytest

from categorizer import LOG_FIELDS, ErrorEvent, emit_error
from support import ManualClock


def test_error_line_uses_only_the_allowlist_in_order() -> None:
    buf = io.StringIO()
    text = emit_error(
        ErrorEvent(
            run_id="run-1",
            game_id="game-1",
            stage="boot",
            error_code="CATEGORIZER_DATABASE_URL",
            provider="openrouter",
            http_status=503,
            attempt=2,
        ),
        clock=ManualClock(),
        stream=buf,
    )
    assert text == buf.getvalue()
    assert text.endswith("\n")
    parsed = json.loads(text)
    assert list(parsed) == list(LOG_FIELDS)
    assert parsed["ts"] == "2026-01-01T00:00:00.000000Z"
    assert parsed["level"] == "error"
    assert parsed["http_status"] == 503
    assert parsed["attempt"] == 2


def test_omitted_fields_are_absent() -> None:
    buf = io.StringIO()
    text = emit_error(ErrorEvent(error_code="CATEGORIZER_DATABASE_URL"), clock=ManualClock(), stream=buf)
    parsed = json.loads(text)
    assert list(parsed) == ["ts", "level", "error_code"]
    assert parsed["error_code"] == "CATEGORIZER_DATABASE_URL"


def test_email_is_not_emitted() -> None:
    probe = "person" + "@" + "example" + "." + "invalid"
    buf = io.StringIO()
    text = emit_error(ErrorEvent(error_code=probe, stage=probe), clock=ManualClock(), stream=buf)
    assert probe not in text
    assert "@" not in text
    parsed = json.loads(text)
    assert parsed["error_code"] == "redacted"
    assert "stage" not in parsed
    assert set(parsed) <= set(LOG_FIELDS)


def test_ip_is_not_emitted() -> None:
    probe = ".".join(("198", "51", "100", "20"))
    buf = io.StringIO()
    text = emit_error(ErrorEvent(run_id=probe), clock=ManualClock(), stream=buf)
    assert probe not in text
    parsed = json.loads(text)
    assert parsed["error_code"] == "redacted"
    assert "run_id" not in parsed


def test_non_allowlisted_field_is_rejected() -> None:
    fields = {"error_code": "ok", "message": "nope"}
    with pytest.raises(TypeError):
        ErrorEvent(**fields)


def test_bool_is_not_an_integer_field() -> None:
    fields = {"http_status": True}
    with pytest.raises(TypeError):
        ErrorEvent(**fields)
