from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from categorizer import LOG_FIELDS, load_settings
from support import boot, valid_environ

ROOT = Path(__file__).resolve().parents[1]

REQUIRED = (
    "CATEGORIZER_DATABASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "TYPESAFE_API_KEY",
    "JEV_MODEL",
    "CATEGORIZER_FETCH_URL",
    "CATEGORIZER_FETCH_SECRET",
)


def _code(env: dict[str, str]) -> tuple[int, dict[str, object], str]:
    code, text, _queue, started = boot(env)
    assert started == []
    parsed = json.loads(text)
    assert parsed["level"] == "error"
    assert parsed["stage"] == "boot"
    assert set(parsed) <= set(LOG_FIELDS)
    return code, parsed, text


def test_missing_environment_names_only_the_first_setting() -> None:
    code, parsed, _text = _code({})
    assert code == 1
    assert parsed["error_code"] == "CATEGORIZER_DATABASE_URL"


@pytest.mark.parametrize("key", REQUIRED)
def test_missing_setting_names_that_setting(key: str) -> None:
    env = valid_environ()
    del env[key]
    code, parsed, _text = _code(env)
    assert code == 1
    assert parsed["error_code"] == key


@pytest.mark.parametrize("key", tuple(valid_environ()))
def test_empty_setting_names_that_setting(key: str) -> None:
    env = valid_environ()
    env[key] = ""
    code, parsed, _text = _code(env)
    assert code == 1
    assert parsed["error_code"] == key


def test_first_invalid_setting_wins() -> None:
    env = valid_environ()
    env["OPENROUTER_API_KEY"] = ""
    env["JEV_MODEL"] = "jev-latest"
    _code_value, parsed, _text = _code(env)
    assert parsed["error_code"] == "OPENROUTER_API_KEY"


@pytest.mark.parametrize(
    "user",
    [
        "postgres",
        "service_role",
        "meshgrounds_admin",
        "meshgrounds_categorizer." + "a" * 19,
        "meshgrounds_categorizer." + "a" * 21,
        "meshgrounds_categorizer." + "A" * 20,
    ],
)
def test_non_categorizer_database_user_is_rejected(user: str) -> None:
    env = valid_environ()
    env["CATEGORIZER_DATABASE_URL"] = "postgresql://" + user + "@localhost/app?sslmode=require"
    code, parsed, text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "CATEGORIZER_DATABASE_URL"
    assert user not in text


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://meshgrounds_categorizer@localhost/app",
        "postgresql://meshgrounds_categorizer@localhost/app?sslmode=prefer",
        "postgresql://meshgrounds_categorizer@localhost/app?sslmode=require&sslmode=disable",
        "http://meshgrounds_categorizer@localhost/app?sslmode=require",
        "postgresql://meshgrounds_categorizer@localhost?sslmode=require",
        "postgresql://meshgrounds_categorizer@/app?sslmode=require",
        "postgresql://meshgrounds_categorizer@localhost/app?sslmode=require#frag",
    ],
)
def test_database_url_shape_is_rejected(url: str) -> None:
    env = valid_environ()
    env["CATEGORIZER_DATABASE_URL"] = url
    code, parsed, text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "CATEGORIZER_DATABASE_URL"
    assert "sslmode" not in text
    assert "frag" not in text


def test_database_password_is_not_logged() -> None:
    marker = "pw-marker"
    env = valid_environ()
    env["CATEGORIZER_DATABASE_URL"] = (
        "postgresql://meshgrounds_categorizer:" + marker + "@localhost/app?sslmode=disable"
    )
    _code_value, parsed, text = _code(env)
    assert parsed["error_code"] == "CATEGORIZER_DATABASE_URL"
    assert marker not in text


def test_secret_values_are_not_logged_when_a_later_setting_fails() -> None:
    env = valid_environ()
    env["OPENROUTER_API_KEY"] = "router-key-marker"
    env["TYPESAFE_API_KEY"] = "typesafe-key-marker"
    env["JEV_MODEL"] = "jev-latest"
    _code_value, parsed, text = _code(env)
    assert parsed["error_code"] == "JEV_MODEL"
    assert "router-key-marker" not in text
    assert "typesafe-key-marker" not in text
    assert "jev-latest" not in text


@pytest.mark.parametrize("key", ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"])
@pytest.mark.parametrize("value", ["", "has space", "has\nbreak", "notasciié"])
def test_api_keys_must_be_nonempty_ascii(key: str, value: str) -> None:
    env = valid_environ()
    env[key] = value
    code, parsed, text = _code(env)
    assert code == 1
    assert parsed["error_code"] == key
    if value:
        assert value not in text


@pytest.mark.parametrize("model", ["openrouter/auto", "openrouter/free", "OpenRouter/auto", "example"])
def test_openrouter_model_rejects_router_aliases_and_bad_ids(model: str) -> None:
    env = valid_environ()
    env["OPENROUTER_MODEL"] = model
    code, parsed, text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "OPENROUTER_MODEL"
    assert model not in text


@pytest.mark.parametrize("model", ["jev-latest", "JEV-LATEST", "Jev-Latest"])
def test_jev_latest_is_rejected(model: str) -> None:
    env = valid_environ()
    env["JEV_MODEL"] = model
    code, parsed, text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "JEV_MODEL"
    assert model not in text


@pytest.mark.parametrize(
    "url",
    [
        "http://fetch.example/hook",
        "https://fetch.example/hook#frag",
        "https://" + "user" + "@" + "fetch.example/hook",
        "https:///hook",
    ],
)
def test_fetch_url_must_be_https_without_userinfo(url: str) -> None:
    env = valid_environ()
    env["CATEGORIZER_FETCH_URL"] = url
    code, parsed, text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "CATEGORIZER_FETCH_URL"
    assert url not in text


def test_fetch_secret_must_be_base64url_of_at_least_32_bytes() -> None:
    short = base64.urlsafe_b64encode(b"b" * 31).decode("ascii").rstrip("=")
    plus = fetch_with_plus()
    for value in (short, plus, "a" * 40 + "/"):
        env = valid_environ()
        env["CATEGORIZER_FETCH_SECRET"] = value
        code, parsed, text = _code(env)
        assert code == 1
        assert parsed["error_code"] == "CATEGORIZER_FETCH_SECRET"
        assert value not in text


def fetch_with_plus() -> str:
    return "abcd" + "+" + "efgh"


@pytest.mark.parametrize("raw", ["0", "51", "01", "10.0", "-1", "1_0", "10 ", " 10"])
def test_max_runs_out_of_range_names_the_setting(raw: str) -> None:
    env = valid_environ()
    env["CATEGORIZER_MAX_RUNS"] = raw
    code, parsed, _text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "CATEGORIZER_MAX_RUNS"
    assert set(parsed) == {"ts", "level", "stage", "error_code"}


@pytest.mark.parametrize("raw", ["59", "1801", "060", "60.0", "600 "])
def test_max_seconds_out_of_range_names_the_setting(raw: str) -> None:
    env = valid_environ()
    env["CATEGORIZER_MAX_SECONDS"] = raw
    code, parsed, _text = _code(env)
    assert code == 1
    assert parsed["error_code"] == "CATEGORIZER_MAX_SECONDS"
    assert set(parsed) == {"ts", "level", "stage", "error_code"}


def test_valid_settings_apply_budget_defaults_and_hide_secrets() -> None:
    env = valid_environ()
    del env["CATEGORIZER_MAX_RUNS"]
    del env["CATEGORIZER_MAX_SECONDS"]
    settings = load_settings(env)
    assert settings.limits.max_runs == 10
    assert settings.limits.max_seconds == 600
    assert settings.openrouter_model == "example/test-model"
    assert settings.jev_model == "jev-1.13.0"
    assert settings.fetch_url == "https://fetch.example/hook"
    assert str(settings.openrouter_api_key) == "Secret"
    assert str(settings.typesafe_api_key) == "Secret"
    assert str(settings.database_url) == "Secret"
    assert str(settings.fetch_secret) == "Secret"
    assert settings.openrouter_api_key.reveal() == env["OPENROUTER_API_KEY"]
    with pytest.raises(TypeError):
        json.dumps(settings.openrouter_api_key)


def test_budget_bounds_are_accepted() -> None:
    low = valid_environ()
    low["CATEGORIZER_MAX_RUNS"] = "1"
    low["CATEGORIZER_MAX_SECONDS"] = "60"
    assert load_settings(low).limits.max_runs == 1
    assert load_settings(low).limits.max_seconds == 60
    high = valid_environ()
    high["CATEGORIZER_MAX_RUNS"] = "50"
    high["CATEGORIZER_MAX_SECONDS"] = "1800"
    assert load_settings(high).limits.max_runs == 50
    assert load_settings(high).limits.max_seconds == 1800


def test_pooler_user_and_postgres_scheme_are_accepted() -> None:
    env = valid_environ()
    user = "meshgrounds_categorizer." + "a" * 20
    env["CATEGORIZER_DATABASE_URL"] = "postgres://" + user + "@localhost/app?sslmode=require"
    settings = load_settings(env)
    assert settings.database_url.reveal() == env["CATEGORIZER_DATABASE_URL"]


def test_process_exits_nonzero_and_names_only_the_setting() -> None:
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
    proc = subprocess.run(
        [sys.executable, "-m", "categorizer"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert proc.returncode != 0
    assert proc.stderr == ""
    parsed = json.loads(proc.stdout)
    assert parsed["error_code"] == "CATEGORIZER_DATABASE_URL"
    assert parsed["level"] == "error"
