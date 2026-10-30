"""Turns diffed rows into the figures the model is asked to narrate.

Originally baseoil's PriceBatchSummariser, which read these numbers back out
of the site's database with SQL aggregates. Here they are computed from the
rows the differ produced, so the module stays site-agnostic.

Nothing in this file asks a model for a number. That is the point: the model
narrates figures it is given, and cannot invent one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .differ import DiffedRow, js_number

# Below this, a single price move is not automatically suspicious on its own.
# It can still be caught by the relative check against the rest of the batch,
# just not by the absolute one.
OUTLIER_ABS_PCT_THRESHOLD = 50

# A change more than this many standard deviations from the batch's own
# average is an outlier relative to its neighbours, even when its absolute
# size is unremarkable.
OUTLIER_STDDEV_MULTIPLE = 3


@dataclass(frozen=True)
class Move:
    location: str
    old: float
    new: float
    change_pct: float


@dataclass(frozen=True)
class SuspectedError:
    location: str
    old_price: float | None
    new_price: float
    status: str
    reason: str


@dataclass(frozen=True)
class Changes:
    rose: int
    fell: int
    median_change_pct: float | None
    largest_rise: Move | None
    largest_fall: Move | None


@dataclass(frozen=True)
class PriceSummary:
    total_rows: int
    price_date: str
    by_status: dict[str, int]
    changes: Changes
    suspected_errors: list[SuspectedError]


def summarise(rows: list[DiffedRow], price_date: str) -> PriceSummary:
    return PriceSummary(
        total_rows=len(rows),
        price_date=price_date,
        by_status=_by_status(rows),
        changes=_changes(rows),
        suspected_errors=_suspected_errors(rows),
    )


def _by_status(rows: list[DiffedRow]) -> dict[str, int]:
    counts: dict[str, int] = {}

    for row in rows:
        counts[row.status] = counts.get(row.status, 0) + 1

    return dict(sorted(counts.items()))


def _moves_of(rows: list[DiffedRow]) -> list[Move]:
    """Movement figures, over rows that have both an old and a new price.

    A `new` row has nothing to have moved from, and an old price of zero would
    make the percentage meaningless rather than merely large.
    """
    moves: list[Move] = []

    for row in rows:
        if row.old_price is None or row.old_price == 0 or not math.isfinite(row.new_price):
            continue

        change_pct = ((row.new_price - row.old_price) / row.old_price) * 100

        if abs(change_pct) < 0.00001:
            continue

        moves.append(
            Move(
                location=row.location,
                old=row.old_price,
                new=row.new_price,
                change_pct=_round2(change_pct),
            )
        )

    return moves


def _changes(rows: list[DiffedRow]) -> Changes:
    moves = _moves_of(rows)
    pcts = sorted(move.change_pct for move in moves)

    return Changes(
        rose=len([pct for pct in pcts if pct > 0]),
        fell=len([pct for pct in pcts if pct < 0]),
        median_change_pct=_median(pcts),
        largest_rise=_extreme(moves, rising=True),
        largest_fall=_extreme(moves, rising=False),
    )


def _median(sorted_pcts: list[float]) -> float | None:
    if not sorted_pcts:
        return None

    middle = len(sorted_pcts) // 2

    if len(sorted_pcts) % 2 == 1:
        return _round2(sorted_pcts[middle])

    return _round2((sorted_pcts[middle - 1] + sorted_pcts[middle]) / 2)


def _extreme(moves: list[Move], rising: bool) -> Move | None:
    candidates = [m for m in moves if (m.change_pct > 0 if rising else m.change_pct < 0)]

    if not candidates:
        return None

    return max(candidates, key=lambda m: m.change_pct) if rising else min(
        candidates, key=lambda m: m.change_pct
    )


def _suspected_errors(rows: list[DiffedRow]) -> list[SuspectedError]:
    """Rows worth a second look before committing.

    This is the figure that earns the AI review its keep: it is what turns
    "84 rows changed" into "84 rows changed, and this one is a typo".
    """
    reasons: dict[int, list[str]] = {}

    def push(index: int, reason: str) -> None:
        reasons.setdefault(index, []).append(reason)

    for index, pct in _outlier_rows(rows).items():
        row = rows[index]
        shown = js_number(_round1(pct))
        push(
            index,
            f"Changed by {'+' + str(shown) if pct > 0 else shown}% "
            f"({js_number(row.old_price)} -> {js_number(row.new_price)}), "
            f"an unusually large move for this batch.",
        )

    # A price that cannot be right at all, regardless of how it compares to
    # the rest of the batch. A row can collect both this and the outlier
    # reason above -- 59.10 -> 0 is both a -100% move and a zero.
    for index, row in enumerate(rows):
        if row.new_price == 0:
            push(index, "The proposed price is zero.")
        elif math.isfinite(row.new_price) and row.new_price < 0:
            push(index, f"The proposed price is negative ({js_number(row.new_price)}).")

        if row.status == "invalid":
            push(index, "The row was rejected as invalid.")

    return [
        SuspectedError(
            location=rows[index].location,
            old_price=rows[index].old_price,
            new_price=rows[index].new_price,
            status=rows[index].status,
            reason=" ".join(row_reasons),
        )
        for index, row_reasons in sorted(reasons.items())
    ]


def _outlier_rows(rows: list[DiffedRow]) -> dict[int, float]:
    """Indexes of `changed` rows whose percentage move is an outlier.

    More than OUTLIER_STDDEV_MULTIPLE standard deviations from the batch's own
    mean, OR larger in absolute terms than OUTLIER_ABS_PCT_THRESHOLD whatever
    the batch's spread. The absolute floor is what catches a single wild jump
    in an otherwise flat batch, where the standard deviation is near zero and
    a multiple of it would be a meaningless bar.
    """
    pcts: dict[int, float] = {}

    for index, row in enumerate(rows):
        if row.status != "changed" or row.old_price is None or row.old_price == 0:
            continue

        pcts[index] = ((row.new_price - row.old_price) / row.old_price) * 100

    if not pcts:
        return {}

    values = list(pcts.values())
    mean = sum(values) / len(values)
    variance = sum((pct - mean) ** 2 for pct in values) / len(values)
    stddev = math.sqrt(variance)

    outliers: dict[int, float] = {}

    for index, pct in pcts.items():
        far_from_the_rest = stddev > 0.0001 and abs(pct - mean) > OUTLIER_STDDEV_MULTIPLE * stddev

        if far_from_the_rest or abs(pct) >= OUTLIER_ABS_PCT_THRESHOLD:
            outliers[index] = pct

    return outliers


def _round1(value: float) -> float:
    return math.floor(value * 10 + 0.5) / 10 if value >= 0 else -(math.floor(-value * 10 + 0.5) / 10)


def _round2(value: float) -> float:
    """Rounds half away from zero, as JavaScript's Math.round does for
    positives and Python's round() does not -- round(2.675, 2) is 2.67 in
    Python because of banker's rounding, and the figures here were pinned by
    the TypeScript version's tests."""
    return math.floor(value * 100 + 0.5) / 100 if value >= 0 else -(
        math.floor(-value * 100 + 0.5) / 100
    )
