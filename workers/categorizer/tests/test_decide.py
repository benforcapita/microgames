from __future__ import annotations

import itertools

import pytest

from categorizer.decide import Category, Lean, decide, decide_all

NSFW = Category(
    slug="nsfw",
    name="NSFW",
    definition="explicit content",
    kind="safety",
    confirm_threshold=0.80,
    reject_threshold=0.05,
)
KID_SAFE = Category(
    slug="kid_safe",
    name="Appropriate for kids",
    definition="suitable for children",
    kind="safety",
    confirm_threshold=0.95,
    reject_threshold=0.20,
)
PUZZLE = Category(
    slug="puzzle",
    name="Puzzle",
    definition="puzzle mechanics",
    kind="content",
    confirm_threshold=0.85,
    reject_threshold=0.15,
)


@pytest.mark.parametrize(
    ("cat", "p", "expected"),
    [
        (NSFW, 0.80, "confirmed"),
        (NSFW, 0.81, "confirmed"),
        (NSFW, 1.0, "confirmed"),
        (NSFW, 0.799, "needs_review"),
        (NSFW, 0.5, "needs_review"),
        (NSFW, 0.051, "needs_review"),
        (NSFW, 0.05, "rejected"),
        (NSFW, 0.049, "rejected"),
        (NSFW, 0.0, "rejected"),
        (NSFW, None, "needs_review"),
        (KID_SAFE, 0.95, "confirmed"),
        (KID_SAFE, 0.96, "confirmed"),
        (KID_SAFE, 0.949, "needs_review"),
        (KID_SAFE, 0.5, "needs_review"),
        (KID_SAFE, 0.201, "needs_review"),
        (KID_SAFE, 0.20, "rejected"),
        (KID_SAFE, 0.199, "rejected"),
        (KID_SAFE, 0.0, "rejected"),
        (KID_SAFE, None, "needs_review"),
        (PUZZLE, 0.85, "confirmed"),
        (PUZZLE, 0.86, "confirmed"),
        (PUZZLE, 0.849, "needs_review"),
        (PUZZLE, 0.5, "needs_review"),
        (PUZZLE, 0.151, "needs_review"),
        (PUZZLE, 0.15, "rejected"),
        (PUZZLE, 0.149, "rejected"),
        (PUZZLE, None, "needs_review"),
    ],
)
def test_decide_maps_p_to_a_verdict_at_every_threshold_edge(
    cat: Category, p: float | None, expected: str
) -> None:
    assert decide(p, cat) == expected


@pytest.mark.parametrize("cat", [NSFW, KID_SAFE])
@pytest.mark.parametrize("p", [0.0, 1.0])
def test_injection_forces_needs_review_on_safety_verdicts(cat: Category, p: float) -> None:
    assert decide(p, cat, injection=True) == "needs_review"


@pytest.mark.parametrize(("p", "expected"), [(1.0, "confirmed"), (0.0, "rejected")])
def test_injection_does_not_change_content_verdicts(p: float, expected: str) -> None:
    assert decide(p, PUZZLE, injection=True) == expected


@pytest.mark.parametrize(
    ("lean", "p", "expected"),
    [
        ("yes", 0.05, "needs_review"),
        ("yes", 0.0, "needs_review"),
        ("no", 0.80, "needs_review"),
        ("no", 1.0, "needs_review"),
        ("yes", 0.80, "confirmed"),
        ("yes", 1.0, "confirmed"),
        ("no", 0.05, "rejected"),
        ("no", 0.0, "rejected"),
        ("unsure", 0.80, "confirmed"),
        ("unsure", 0.05, "rejected"),
        (None, 0.80, "confirmed"),
        (None, 0.05, "rejected"),
    ],
)
def test_safety_disagreement_between_lean_and_verdict_forces_review(
    lean: str | None, p: float, expected: str
) -> None:
    assert decide(p, NSFW, lean=lean) == expected


@pytest.mark.parametrize(
    ("lean", "p", "expected"),
    [("yes", 0.0, "rejected"), ("no", 1.0, "confirmed"), ("unsure", 0.9, "confirmed")],
)
def test_lean_does_not_change_content_verdicts(
    lean: str, p: float, expected: str
) -> None:
    assert decide(p, PUZZLE, lean=lean) == expected


def test_decide_all_decides_each_asked_category() -> None:
    verdicts = decide_all(
        [NSFW, KID_SAFE, PUZZLE],
        {"nsfw": 0.9, "kid_safe": 0.1, "puzzle": 0.9},
        {},
    )
    assert verdicts == {
        "nsfw": "confirmed",
        "kid_safe": "rejected",
        "puzzle": "confirmed",
    }


def test_decide_all_marks_missing_answers_needs_review() -> None:
    verdicts = decide_all([NSFW, KID_SAFE], {"nsfw": 0.9}, {})
    assert verdicts == {"nsfw": "confirmed", "kid_safe": "needs_review"}


def test_nsfw_and_kid_safe_both_confirmed_force_needs_review_on_both() -> None:
    verdicts = decide_all(
        [NSFW, KID_SAFE, PUZZLE],
        {"nsfw": 0.9, "kid_safe": 0.99, "puzzle": 0.9},
        {},
    )
    assert verdicts == {
        "nsfw": "needs_review",
        "kid_safe": "needs_review",
        "puzzle": "confirmed",
    }


def test_nsfw_confirmed_does_not_change_a_clean_kid_safe_verdict() -> None:
    verdicts = decide_all(
        [NSFW, KID_SAFE],
        {"nsfw": 0.9, "kid_safe": 0.5},
        {},
    )
    assert verdicts == {"nsfw": "confirmed", "kid_safe": "needs_review"}


def test_nsfw_rejected_with_kid_safe_confirmed_is_not_a_conflict() -> None:
    verdicts = decide_all(
        [NSFW, KID_SAFE],
        {"nsfw": 0.01, "kid_safe": 0.99},
        {"kid_safe": "yes"},
    )
    assert verdicts == {"nsfw": "rejected", "kid_safe": "confirmed"}


def test_decide_all_applies_safety_rules_before_the_conflict_rule() -> None:
    verdicts = decide_all(
        [NSFW, KID_SAFE],
        {"nsfw": 0.9, "kid_safe": 0.99},
        {"kid_safe": "no"},
    )
    assert verdicts == {"nsfw": "confirmed", "kid_safe": "needs_review"}


def _edges(cat: Category) -> tuple[float | None, ...]:
    return (
        0.0,
        cat.reject_threshold,
        cat.reject_threshold + 0.01,
        (cat.reject_threshold + cat.confirm_threshold) / 2,
        cat.confirm_threshold - 0.01,
        cat.confirm_threshold,
        1.0,
        None,
    )


def test_nsfw_confirmed_never_leaves_kid_safe_confirmed() -> None:
    combinations = 0
    for nsfw_p, kid_p, nsfw_lean, kid_lean, injection in itertools.product(
        _edges(NSFW),
        _edges(KID_SAFE),
        ("yes", "no", "unsure", None),
        ("yes", "no", "unsure", None),
        (False, True),
    ):
        combinations += 1
        leans: dict[str, Lean] = {}
        if nsfw_lean is not None:
            leans["nsfw"] = nsfw_lean
        if kid_lean is not None:
            leans["kid_safe"] = kid_lean
        verdicts = decide_all(
            [NSFW, KID_SAFE],
            {"nsfw": nsfw_p, "kid_safe": kid_p},
            leans,
            injection=injection,
        )
        before_conflict = decide(
            nsfw_p, NSFW, lean=nsfw_lean, injection=injection
        )
        if verdicts["nsfw"] == "confirmed" or before_conflict == "confirmed":
            assert verdicts["kid_safe"] != "confirmed", (
                nsfw_p,
                kid_p,
                nsfw_lean,
                kid_lean,
                injection,
            )
    assert combinations == 2048
