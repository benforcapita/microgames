from __future__ import annotations

import json
import os
import signal

from categorizer import FakeQueue, Stop, Workload, bind_sigterm, main, process_deps
from support import ManualClock, boot, valid_environ


class HoldingQueue:
    def __init__(self, pending: tuple[str, ...]) -> None:
        self.pending = pending
        self.claim_calls = 0

    def claim(self) -> None:
        self.claim_calls += 1


def test_empty_queue_exits_zero() -> None:
    code, text, queue, handled = boot(valid_environ())
    assert code == 0
    assert text == ""
    assert handled == []
    assert queue.claim_calls == 1


def test_kill_switch_exits_zero_without_taking_work() -> None:
    queue = HoldingQueue(("run-a", "run-b"))
    code, text, _queue, handled = boot(valid_environ(), queue=queue)
    assert code == 0
    assert text == ""
    assert handled == []
    assert queue.pending == ("run-a", "run-b")
    assert queue.claim_calls == 1


def test_max_runs_stops_before_the_next_claim() -> None:
    queue = FakeQueue(("a", "b", "c"))
    env = valid_environ()
    env["CATEGORIZER_MAX_RUNS"] = "2"
    code, text, _queue, handled = boot(env, queue=queue)
    assert code == 0
    assert text == ""
    assert handled == ["a", "b"]
    assert queue.claim_calls == 2


def test_max_seconds_finishes_the_current_run_and_does_not_claim_again() -> None:
    clock = ManualClock()
    queue = FakeQueue(("a", "b", "c"))
    handled: list[object] = []

    def workload(_settings: object) -> Workload[object]:
        def handle(item: object) -> None:
            handled.append(item)
            clock.advance(60)

        return Workload(queue=queue, handle=handle)

    env = valid_environ()
    env["CATEGORIZER_MAX_SECONDS"] = "60"
    code, text, _queue, _handled = boot(env, queue=queue, clock=clock, workload=workload)
    assert code == 0
    assert text == ""
    assert handled == ["a"]
    assert queue.claim_calls == 1


def test_sigterm_exits_zero_and_stops_claiming() -> None:
    queue = FakeQueue(("a", "b", "c"))
    handled: list[object] = []

    def workload(_settings: object) -> Workload[object]:
        def handle(item: object) -> None:
            handled.append(item)
            os.kill(os.getpid(), signal.SIGTERM)

        return Workload(queue=queue, handle=handle)

    code, text, _queue, _handled = boot(
        valid_environ(),
        queue=queue,
        stop=Stop(),
        bind_signal=bind_sigterm,
        workload=workload,
    )
    assert code == 0
    assert text == ""
    assert handled == ["a"]
    assert queue.claim_calls == 1


def test_handler_failure_names_a_code_and_hides_the_exception() -> None:
    marker = "handler-boom-marker"
    queue = FakeQueue(("a", "b"))

    def workload(_settings: object) -> Workload[object]:
        def handle(_item: object) -> None:
            raise RuntimeError(marker)

        return Workload(queue=queue, handle=handle)

    code, text, _queue, _handled = boot(valid_environ(), queue=queue, workload=workload)
    assert code == 1
    assert marker not in text
    parsed = json.loads(text)
    assert parsed["error_code"] == "handler_failed"
    assert parsed["stage"] == "drain"
    assert queue.claim_calls == 1


def test_workload_failure_names_a_code_and_hides_the_exception() -> None:
    marker = "workload-boom-marker"

    def workload(_settings: object) -> Workload[object]:
        raise RuntimeError(marker)

    code, text, queue, _handled = boot(valid_environ(), workload=workload)
    assert code == 1
    assert marker not in text
    assert json.loads(text)["error_code"] == "workload_failed"
    assert queue.claim_calls == 0


def test_idle_process_exits_zero() -> None:
    code = main(valid_environ(), process_deps())
    assert code == 0
