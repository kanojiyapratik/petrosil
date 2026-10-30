"""Compares proposed prices against the ones a calling site already holds.

Stateless by design: everything needed to judge an upload arrives in the
request, which is what lets one deployment serve any site. Ported from the
TypeScript version, which was itself ported from baseoil's PHP PriceDiffer --
the rules below have survived all three and are the site's, not ours.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable

# Prices are floats; compare with a tolerance rather than ==.
PRICE_TOLERANCE = 0.00001


@dataclass(frozen=True)
class ProposedRow:
    location: str
    # Any, not float: a spreadsheet cell can hold anything at all.
    price: Any


@dataclass(frozen=True)
class CurrentPrice:
    location: str
    price: float


@dataclass(frozen=True)
class DiffedRow:
    location: str
    old_price: float | None
    new_price: float
    status: str


def diff_prices(
    price_date: str,
    rows: Iterable[ProposedRow],
    current_prices: Iterable[CurrentPrice],
    valid_locations: Iterable[str],
    today: str | None = None,
) -> list[DiffedRow]:
    current = {entry.location: float(entry.price) for entry in current_prices}
    live = set(valid_locations)
    today = today or date.today().isoformat()

    diffed: list[DiffedRow] = []

    for row in rows:
        old_price = current.get(row.location)
        new_price = to_price(row.price)

        diffed.append(
            DiffedRow(
                location=row.location,
                old_price=old_price,
                new_price=float("nan") if new_price is None else new_price,
                status=_classify(row.location, live, old_price, new_price, price_date, today),
            )
        )

    return diffed


def _classify(
    location: str,
    live: set[str],
    old_price: float | None,
    new_price: float | None,
    price_date: str,
    today: str,
) -> str:
    if location not in live:
        return "unmatched"

    # Rejected, never clamped: a negative or unreadable price is a problem
    # with the sheet, and silently turning it into 0 would publish a wrong
    # price rather than surface the mistake.
    if new_price is None or new_price < 0:
        return "invalid"

    if old_price is None:
        return "new"

    if abs(old_price - new_price) < PRICE_TOLERANCE:
        return "unchanged"

    # Published history is immutable: a price already recorded on a past date
    # is never rewritten. Backfilling an *empty* past date stays allowed --
    # that is the branch above, and it matters because prices arrive days
    # after the date they apply to.
    if price_date < today:
        return "locked"

    return "changed"


def to_price(value: Any) -> float | None:
    """A price, or None. Never a silent zero, never a negative.

    ``bool`` is excluded deliberately: it is a subclass of ``int`` in Python,
    so ``True`` would otherwise sail through as a price of 1.0. The JavaScript
    version guarded the mirror-image trap -- ``Number('')`` is 0 there -- and
    both exist for the same reason: a blank cell must never become a price.
    """
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        stripped = value.strip()

        if stripped == "":
            return None

        try:
            number = float(stripped)
        except ValueError:
            return None
    else:
        return None

    if number != number or number in (float("inf"), float("-inf")):
        return None

    return number


def js_number(value: float | int | None) -> float | int | None:
    """Renders a float the way JavaScript does: 600.0 becomes 600.

    Not cosmetic. These numbers go into JSON that a PHP site decodes, and into
    the reason strings an admin reads -- "Changed by +100.0% (600.0 -> 1200.0)"
    against the TypeScript version's "+100% (600 -> 1200)". The port is only
    faithful if both come out the same.
    """
    if value is None or isinstance(value, bool):
        return value

    number = float(value)

    if number != number or number in (float("inf"), float("-inf")):
        return number

    return int(number) if number.is_integer() else number
