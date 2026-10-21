from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

Verdict = Literal["confirmed", "rejected", "needs_review"]
Lean = Literal["yes", "no", "unsure"]
Kind = Literal["safety", "content"]

CONFIRMED: Verdict = "confirmed"
REJECTED: Verdict = "rejected"
NEEDS_REVIEW: Verdict = "needs_review"


@dataclass(frozen=True)
class Category:
    slug: str
    name: str
    definition: str
    kind: Kind
    confirm_threshold: float
    reject_threshold: float


def decide(
    p: float | None,
    cat: Category,
    *,
    lean: Lean | None = None,
    injection: bool = False,
) -> Verdict:
    if p is None:
        return NEEDS_REVIEW
    verdict: Verdict
    if p >= cat.confirm_threshold:
        verdict = CONFIRMED
    elif p <= cat.reject_threshold:
        verdict = REJECTED
    else:
        return NEEDS_REVIEW
    if cat.kind == "safety":
        if injection:
            return NEEDS_REVIEW
        if (lean == "yes" and verdict == REJECTED) or (
            lean == "no" and verdict == CONFIRMED
        ):
            return NEEDS_REVIEW
    return verdict


def decide_all(
    categories: Sequence[Category],
    probs: Mapping[str, float | None],
    leans: Mapping[str, Lean],
    *,
    injection: bool = False,
) -> dict[str, Verdict]:
    verdicts = {
        cat.slug: decide(
            probs.get(cat.slug), cat, lean=leans.get(cat.slug), injection=injection
        )
        for cat in categories
    }
    if verdicts.get("nsfw") == CONFIRMED and verdicts.get("kid_safe") == CONFIRMED:
        verdicts["nsfw"] = NEEDS_REVIEW
        verdicts["kid_safe"] = NEEDS_REVIEW
    return verdicts
