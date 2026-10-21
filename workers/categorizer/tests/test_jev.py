from __future__ import annotations

import io
import json
import logging
from collections.abc import Sequence

import httpx2
import pytest
from typesafe_sdk import Noul, TypeSafeRateLimitError

from categorizer import ErrorEvent, Limits, Secret, Settings, emit_error
from categorizer.decide import Category, decide_all
from categorizer.models.jev import FakeJev, JevError, TypeSafeJev, judge
from support import ManualClock

KEY = "ts-test-KEY-PLACEHOLDER"
MODEL = "jev-1.13.0"
URL = "https://api.typesafe.ai/v1/systemone"
STATE = {"task": "judge the game", "game": {"title": "tiny game", "text_excerpt": "jump"}}

NSFW = Category(
    slug="nsfw",
    name="NSFW",
    definition="nsfw definition",
    kind="safety",
    confirm_threshold=0.80,
    reject_threshold=0.05,
)
KID_SAFE = Category(
    slug="kid_safe",
    name="Kid safe",
    definition="kid definition",
    kind="safety",
    confirm_threshold=0.95,
    reject_threshold=0.20,
)


def _content(count: int) -> list[Category]:
    return [
        Category(
            slug=f"c{i}",
            name=f"Cat {i}",
            definition=f"def {i}",
            kind="content",
            confirm_threshold=0.85,
            reject_threshold=0.15,
        )
        for i in range(count)
    ]


def _slugs(categories: Sequence[Category]) -> list[str]:
    return [cat.slug for cat in categories if cat.kind == "content"]


def _settings(model: str = MODEL) -> Settings:
    return Settings(
        database_url=Secret("placeholder"),
        openrouter_api_key=Secret("placeholder"),
        openrouter_model="vendor/test-model",
        typesafe_api_key=Secret(KEY),
        jev_model=model,
        fetch_url="https://placeholder.invalid",
        fetch_secret=Secret("placeholder"),
        limits=Limits(max_runs=1, max_seconds=60),
    )


def _ok_body(answers: dict[str, float] | None = None, model: str = MODEL) -> dict[str, object]:
    if answers is None:
        answers = {"t_nsfw": 0.9}
    return {
        "model": model,
        "usage": {"input_tokens": 10, "output_tokens": 2},
        "answers": {name: {"type": "noul", "noul": p} for name, p in answers.items()},
    }


def _ok(
    answers: dict[str, float] | None = None,
    request_id: str = "req-1",
    model: str = MODEL,
) -> httpx2.Response:
    return httpx2.Response(
        200, json=_ok_body(answers, model), headers={"x-typesafe-request-id": request_id}
    )


class Api:
    def __init__(self, steps: Sequence[httpx2.Response | Exception]) -> None:
        self._steps = list(steps)
        self.requests: list[httpx2.Request] = []
        self.transport = httpx2.MockTransport(self._handle)

    def _handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if not self._steps:
            return httpx2.Response(500)
        step = self._steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def _errors(statuses: Sequence[int]) -> list[httpx2.Response]:
    return [httpx2.Response(status) for status in statuses]


def _jev(api: Api, model: str = MODEL, sleeps: list[float] | None = None) -> TypeSafeJev:
    return TypeSafeJev(
        _settings(model=model),
        transport=api.transport,
        sleep=(lambda _s: None) if sleeps is None else sleeps.append,
    )


def test_safety_questions_are_asked_first_even_when_not_suggested() -> None:
    fake = FakeJev()
    judge(fake, STATE, [NSFW, KID_SAFE, *_content(2)], ["c0", "c1"])
    assert tuple(fake.questions[0]) == ("t_nsfw", "t_kid_safe", "t_c0", "t_c1")


def test_safety_questions_lead_and_suggested_slugs_are_deduplicated() -> None:
    fake = FakeJev()
    judge(fake, STATE, [NSFW, KID_SAFE, *_content(2)], ["c1", "nsfw", "c0", "kid_safe"])
    assert tuple(fake.questions[0]) == ("t_nsfw", "t_kid_safe", "t_c1", "t_c0")


def test_every_asked_tag_gets_one_noul_question_built_from_the_category() -> None:
    fake = FakeJev()
    judge(fake, STATE, [NSFW, KID_SAFE], [])
    [questions] = fake.questions
    assert set(questions) == {"t_nsfw", "t_kid_safe"}
    for cat in (NSFW, KID_SAFE):
        question = questions[f"t_{cat.slug}"]
        assert type(question) is Noul
        assert question.instructions == f"This game fits the category '{cat.name}'."
        assert question.criteria == {
            "true": cat.definition,
            "false": f"The game does not meet: {cat.definition}",
        }


def test_more_than_eight_questions_are_chunked() -> None:
    cats = [NSFW, KID_SAFE, *_content(10)]
    fake = FakeJev()
    result = judge(fake, STATE, cats, _slugs(cats))
    assert [len(questions) for questions in fake.questions] == [8, 4]
    assert len(result.answers) == 12


def test_exactly_eight_questions_use_one_call() -> None:
    cats = [NSFW, KID_SAFE, *_content(6)]
    fake = FakeJev()
    judge(fake, STATE, cats, _slugs(cats))
    assert [len(questions) for questions in fake.questions] == [8]


def test_every_suggested_tag_is_asked_safety_first_in_chunks_of_eight() -> None:
    cats = [NSFW, KID_SAFE, *_content(20)]
    fake = FakeJev()
    result = judge(fake, STATE, cats, _slugs(cats))
    asked = [name for questions in fake.questions for name in questions]
    assert asked == ["t_nsfw", "t_kid_safe"] + [f"t_c{i}" for i in range(20)]
    assert [len(questions) for questions in fake.questions] == [8, 8, 6]
    assert len(result.answers) == 22


def test_state_is_passed_to_the_backend_verbatim() -> None:
    fake = FakeJev()
    judge(fake, STATE, [NSFW], [])
    assert fake.states == [STATE]


def test_a_missing_answer_is_none_and_decides_needs_review() -> None:
    fake = FakeJev(answers={"t_nsfw": 0.9})
    result = judge(fake, STATE, [NSFW, KID_SAFE], [])
    assert result.answers == {"nsfw": 0.9, "kid_safe": None}
    assert decide_all([NSFW, KID_SAFE], result.answers, {})["kid_safe"] == "needs_review"


def test_answers_model_usage_and_request_ids_aggregate_across_chunks() -> None:
    cats = [NSFW, KID_SAFE, *_content(8)]
    answers = {f"t_{cat.slug}": 0.9 for cat in cats}
    fake = FakeJev(answers=answers, model="jev-1.13.0", usage={"input_tokens": 10, "output_tokens": 2})
    result = judge(fake, STATE, cats, _slugs(cats))
    assert result.model == "jev-1.13.0"
    assert result.usage == {"input_tokens": 20, "output_tokens": 4, "calls": 2}
    assert result.request_ids == ("fake-1", "fake-2")
    assert result.answers == {cat.slug: 0.9 for cat in cats}


def test_request_is_the_pinned_system_one_call() -> None:
    api = Api([_ok({"t_nsfw": 0.9, "t_kid_safe": 0.1})])
    result = judge(_jev(api), STATE, [NSFW, KID_SAFE], [])
    [request] = api.requests
    assert request.method == "POST"
    assert request.url == URL
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert not any(name.startswith("typesafe-danger-zone") for name in request.headers)
    body = json.loads(request.content)
    assert set(body) == {"state", "model", "questions"}
    assert body["model"] == MODEL
    assert body["state"] == STATE
    assert set(body["questions"]) == {"t_nsfw", "t_kid_safe"}
    assert body["questions"]["t_nsfw"] == {
        "type": "noul",
        "instructions": f"This game fits the category '{NSFW.name}'.",
        "criteria": {
            "true": NSFW.definition,
            "false": f"The game does not meet: {NSFW.definition}",
        },
    }
    assert result.answers == {"nsfw": 0.9, "kid_safe": 0.1}


def test_model_comes_from_jev_model() -> None:
    api = Api([_ok()])
    judge(_jev(api, model="jev-9.9.9"), STATE, [NSFW], [])
    assert json.loads(api.requests[0].content)["model"] == "jev-9.9.9"


def test_response_model_usage_request_id_and_answers_are_captured() -> None:
    api = Api([_ok({"t_nsfw": 0.9}, request_id="req-77")])
    result = judge(_jev(api), STATE, [NSFW], [])
    assert result.model == MODEL
    assert result.usage == {"input_tokens": 10, "output_tokens": 2, "calls": 1}
    assert result.request_ids == ("req-77",)
    assert result.answers == {"nsfw": 0.9}


def test_a_missing_wire_answer_decides_needs_review() -> None:
    api = Api([_ok({"t_kid_safe": 0.1})])
    result = judge(_jev(api), STATE, [NSFW, KID_SAFE], [])
    assert result.answers == {"nsfw": None, "kid_safe": 0.1}
    assert decide_all([NSFW, KID_SAFE], result.answers, {})["nsfw"] == "needs_review"


def test_an_out_of_range_noul_is_no_answer() -> None:
    api = Api([_ok({"t_nsfw": 1.5, "t_kid_safe": 0.9})])
    result = judge(_jev(api), STATE, [NSFW, KID_SAFE], [])
    assert result.answers == {"nsfw": None, "kid_safe": 0.9}


def test_a_negative_wire_noul_is_no_answer() -> None:
    api = Api([_ok({"t_nsfw": -0.1, "t_kid_safe": 0.9})])
    result = judge(_jev(api), STATE, [NSFW, KID_SAFE], [])
    assert result.answers == {"nsfw": None, "kid_safe": 0.9}
    assert decide_all([NSFW, KID_SAFE], result.answers, {})["nsfw"] == "needs_review"


@pytest.mark.parametrize(
    "body",
    ["<html>oops</html>", '{"unexpected": true}', '{"model": "x", "usage": {}, "answers": {}}'],
    ids=["html", "wrong_shape", "empty_answers"],
)
def test_an_unparseable_response_means_missing_answers(body: str) -> None:
    api = Api(
        [httpx2.Response(200, content=body, headers={"x-typesafe-request-id": "req-9"})]
    )
    result = judge(_jev(api), STATE, [NSFW], [])
    assert result.answers == {"nsfw": None}
    assert result.request_ids == ("req-9",)


@pytest.mark.parametrize(
    ("status", "code", "attempts"),
    [
        (401, "jev_auth", 1),
        (400, "jev_bad_request", 1),
        (403, "jev_bad_request", 1),
        (404, "jev_bad_request", 1),
        (413, "jev_bad_request", 1),
        (415, "jev_bad_request", 1),
        (422, "jev_bad_request", 1),
        (429, "jev_rate_limited", 3),
        (500, "jev_5xx", 3),
        (529, "jev_5xx", 3),
    ],
)
def test_status_maps_to_error_code_and_retry_count(
    status: int, code: str, attempts: int
) -> None:
    api = Api(_errors([status] * 3))
    sleeps: list[float] = []
    with pytest.raises(JevError) as raised:
        judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert raised.value.code == code
    assert raised.value.http_status == status
    assert raised.value.retryable is (attempts == 3)
    assert len(api.requests) == attempts
    assert len(sleeps) == attempts - 1


def test_max_tokens_exceeded_is_a_permanent_bad_request() -> None:
    api = Api([httpx2.Response(400, json={"error": "max_tokens_exceeded"})])
    with pytest.raises(JevError) as raised:
        judge(_jev(api), STATE, [NSFW], [])
    assert raised.value.code == "jev_bad_request"
    assert raised.value.retryable is False
    assert len(api.requests) == 1


def test_retry_after_header_sets_the_delay() -> None:
    api = Api(
        [
            httpx2.Response(429, headers={"Retry-After": "7"}),
            _ok(),
        ]
    )
    sleeps: list[float] = []
    result = judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert result.model == MODEL
    assert sleeps == [7.0]


def test_retry_after_ms_sets_the_delay() -> None:
    api = Api(
        [
            httpx2.Response(429, headers={"retry-after-ms": "250"}),
            _ok(),
        ]
    )
    sleeps: list[float] = []
    judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert sleeps == [0.25]


def test_backoff_doubles_without_retry_after() -> None:
    api = Api(_errors([500, 500]) + [_ok()])
    sleeps: list[float] = []
    judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert sleeps == [1.0, 2.0]


def test_error_request_id_is_captured() -> None:
    api = Api(
        _errors([429] * 2)
        + [httpx2.Response(429, headers={"x-typesafe-request-id": "req-err"})]
    )
    with pytest.raises(JevError) as raised:
        judge(_jev(api), STATE, [NSFW], [])
    assert raised.value.request_id == "req-err"


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (httpx2.TimeoutException("slow"), "jev_timeout"),
        (httpx2.ConnectError("refused"), "jev_connection"),
    ],
)
def test_transport_failures_map_and_retry(failure: Exception, code: str) -> None:
    api = Api([failure, failure, failure])
    sleeps: list[float] = []
    with pytest.raises(JevError) as raised:
        judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert raised.value.code == code
    assert raised.value.retryable is True
    assert len(api.requests) == 3
    assert sleeps == [1.0, 2.0]


def test_success_after_a_retryable_failure() -> None:
    api = Api([httpx2.TimeoutException("slow"), _ok()])
    sleeps: list[float] = []
    result = judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert result.answers == {"nsfw": 0.9}
    assert sleeps == [1.0]


def _assert_key_unreachable_from(err: JevError) -> None:
    seen: set[int] = set()
    stack: list[BaseException | None] = [err]
    while stack:
        node = stack.pop()
        if node is None or id(node) in seen:
            continue
        seen.add(id(node))
        assert KEY not in str(node)
        assert KEY not in repr(node)
        assert not isinstance(node, httpx2.HTTPError)
        request = getattr(node, "request", None)
        if isinstance(request, httpx2.Request):
            assert KEY not in request.headers.get("authorization", "")
        stack.extend((node.__cause__, node.__context__))


def test_key_never_appears_in_errors_or_log_output() -> None:
    scenarios: list[list[httpx2.Response | Exception]] = [
        _errors([401]),
        _errors([400]),
        _errors([429, 429, 429]),
        _errors([529, 529, 529]),
        [httpx2.TimeoutException("slow")] * 3,
        [httpx2.ConnectError("refused")] * 3,
    ]
    for steps in scenarios:
        api = Api(steps)
        buf = io.StringIO()
        with pytest.raises(JevError) as raised:
            judge(_jev(api), STATE, [NSFW], [])
        err = raised.value
        emit_error(
            ErrorEvent(
                error_code=err.code,
                http_status=err.http_status,
                provider="typesafe",
                attempt=len(api.requests),
            ),
            clock=ManualClock(),
            stream=buf,
        )
        assert KEY not in str(err)
        assert KEY not in repr(err)
        assert KEY not in buf.getvalue()
        _assert_key_unreachable_from(err)


def test_a_server_body_echoing_the_key_never_leaks() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            400, json={"error": "echo " + request.headers["authorization"]}
        )

    jev = TypeSafeJev(
        _settings(), transport=httpx2.MockTransport(handler), sleep=lambda _s: None
    )
    with pytest.raises(JevError) as raised:
        judge(jev, STATE, [NSFW], [])
    err = raised.value
    assert err.code == "jev_bad_request"
    assert KEY not in str(err)
    assert KEY not in repr(err)
    _assert_key_unreachable_from(err)


@pytest.mark.parametrize(
    ("steps", "code"),
    [
        ([_ok()], None),
        (_errors([401]), "jev_auth"),
        ([httpx2.Response(429), _ok()], None),
        ([httpx2.ConnectError("refused"), _ok()], None),
    ],
    ids=["success", "non_retryable_error", "rate_limit_retry", "transport_retry"],
)
def test_key_never_appears_in_logs_stdout_or_stderr(
    steps: list[httpx2.Response | Exception],
    code: str | None,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    api = Api(steps)
    with caplog.at_level(logging.DEBUG, logger="typesafe_sdk"):
        if code is None:
            judge(_jev(api), STATE, [NSFW], [])
        else:
            with pytest.raises(JevError) as raised:
                judge(_jev(api), STATE, [NSFW], [])
            assert raised.value.code == code
    captured = capsys.readouterr()
    assert KEY not in caplog.text
    assert KEY not in captured.out
    assert KEY not in captured.err


def test_the_recorded_model_is_the_response_model_not_the_requested_one() -> None:
    api = Api([_ok({"t_nsfw": 0.9}, model="jev-1.13.0-build7")])
    result = judge(_jev(api), STATE, [NSFW], [])
    assert result.model == "jev-1.13.0-build7"


@pytest.mark.parametrize(
    ("models", "expected"),
    [
        (["jev-a", "jev-b", "jev-c"], "jev-a"),
        (["", "jev-b", "jev-c"], "jev-b"),
    ],
    ids=["first_non_empty_wins", "empty_model_is_skipped"],
)
def test_the_result_model_is_the_first_non_empty_chunk_model(
    models: list[str], expected: str
) -> None:
    cats = [NSFW, KID_SAFE, *_content(15)]
    answers = {f"t_{cat.slug}": 0.9 for cat in cats}
    api = Api([_ok(answers, model=model) for model in models])
    result = judge(_jev(api), STATE, cats, _slugs(cats))
    assert len(api.requests) == 3
    assert result.model == expected


def test_a_suggested_slug_is_asked_once_no_matter_how_often_suggested() -> None:
    cats = [NSFW, KID_SAFE, *_content(6)]
    fake = FakeJev()
    result = judge(fake, STATE, cats, [*_slugs(cats), "c0"])
    assert [len(questions) for questions in fake.questions] == [8]
    assert result.usage["calls"] == 1
    assert set(result.answers) == {cat.slug for cat in cats}


@pytest.mark.parametrize(
    ("steps", "code"),
    [
        ([httpx2.Response(500)] * 3, "jev_5xx"),
        ([httpx2.Response(400)], "jev_bad_request"),
    ],
    ids=["retryable", "permanent"],
)
def test_a_middle_chunk_failure_raises_and_no_tag_is_rejected(
    steps: list[httpx2.Response], code: str
) -> None:
    cats = [NSFW, KID_SAFE, *_content(15)]
    first = {f"t_{cat.slug}": 0.9 for cat in cats[:8]}
    api = Api([_ok(first), *steps, _ok()])
    with pytest.raises(JevError) as raised:
        judge(_jev(api), STATE, cats, _slugs(cats))
    assert raised.value.code == code
    assert len(api.requests) == 1 + len(steps)
    assert set(decide_all(cats, {}, {}).values()) == {"needs_review"}


def test_a_retry_after_header_beyond_the_cap_sleeps_sixty_seconds() -> None:
    api = Api([httpx2.Response(503, headers={"Retry-After": "3600"}), _ok()])
    sleeps: list[float] = []
    judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert sleeps == [60.0]


def test_a_retry_after_ms_beyond_the_cap_sleeps_sixty_seconds() -> None:
    api = Api([httpx2.Response(429, headers={"retry-after-ms": "3600000"}), _ok()])
    sleeps: list[float] = []
    judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert sleeps == [60.0]


def test_a_negative_retry_after_ms_falls_back_to_backoff() -> None:
    error = TypeSafeRateLimitError(429, None, httpx2.Headers())
    error.retry_after_ms = -100.0
    api = Api([error, _ok()])
    sleeps: list[float] = []
    result = judge(_jev(api, sleeps=sleeps), STATE, [NSFW], [])
    assert result.answers == {"nsfw": 0.9}
    assert sleeps == [1.0]
