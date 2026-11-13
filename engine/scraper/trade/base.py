"""What every trade source answers, and the one unit rule they share.

A source is asked for one reporting country's imports or exports of a set
of product codes in one month, and answers one figure per partner country,
in the source's own unit. Nothing here talks to the site.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal


class SourceError(RuntimeError):
    """The source could not be read: down, changed its page, refused us."""


class NoData(RuntimeError):
    """The source answered, and has nothing for that month yet."""


@dataclass(frozen=True)
class Figure:
    """One partner's quantity, as the source wrote it."""

    partner: str
    quantity: Decimal
    unit: str
    iso2: str | None = None


@dataclass
class MonthResult:
    figures: list[Figure] = field(default_factory=list)
    source_url: str | None = None


# Units already in thousands of their base unit: a metric tonne is a
# thousand kilograms, a kilolitre a thousand litres. Japan's bitumen is in
# MT and the sheets hold it as written (Korea 27,192 MT in April 2026 is
# 27,192 on bitumart).
_THOUSANDS = {"MT", "TON", "TONNE", "TONNES", "TNE", "KL", "KLT"}

# Units the team divided by a thousand: Thailand's base oil arrives in
# litres (31,106,885 LTR from Singapore in April 2026 is 31,107 on baseoil),
# India's and Comtrade's in kilograms.
_UNITS = {"KG", "KGS", "KGM", "LTR", "L", "LITRE", "LITRES"}


def sheet_unit(unit: str) -> str:
    """KGS or LTR, which is what a sheet figure is a thousand of."""
    clean = unit.strip().upper()

    if clean in {"KL", "KLT", "LTR", "L", "LITRE", "LITRES"}:
        return "LTR"

    return "KGS"


def sheet_quantity(quantity: Decimal, unit: str) -> Decimal:
    """The source's figure as the sheets hold it: thousands, to the unit.

    Rounded half up, because that is what reproduces the hand-entered
    history (Indonesia's 41,565 litres is 42, not 41).
    """
    clean = unit.strip().upper()

    if clean in _THOUSANDS:
        value = quantity
    elif clean in _UNITS:
        value = quantity / 1000
    else:
        raise SourceError(f"The source gave a quantity in {unit!r}, which we do not know how to convert.")

    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def parse_number(text: str) -> Decimal | None:
    """'1,234,567.00' → Decimal; blanks, dashes and '(R)' marks → None or stripped."""
    clean = (
        text.replace(",", "")
        .replace("\xa0", "")
        .replace("(R)", "")
        .replace("(F)", "")
        .strip()
    )

    if clean in {"", "-", "--", "N.A.", "NA"}:
        return None

    try:
        return Decimal(clean)
    except Exception:  # noqa: BLE001 - anything else is not a number
        return None
