"""Every price, with the arithmetic that produced it.

preflight.py stops a sheet that contradicts itself. This is the other half
of the October 2026 problem, and the one that explains why the same rows
came back in all four mismatch files.

Look at which rows recurred: Greece, Italy and Spain FOB (all three one
Mediterranean assessment), Singapore Drums (+$20), Iran bulk and drums
(+$15), Brussels (+EUR 5), Taiwan, Thailand, Korea and Singapore (a midpoint,
then rounded). Every one of them is a figure that is **not printed anywhere
in the report**. The client opens the Argus PDF, searches for 575, does not
find it, and asks. They are not being careless -- they cannot check those
numbers, so they query them, every time, forever.

The rows that never recurred are the ones you can read straight off a page:
BPCL, HPCL, IOCL, Bahrain, the African CFRs.

So each price states its own derivation, in the client's own terms, and the
sheet that goes out carries it:

    Argus Bitumen 26-41 quoted 571.6-576.1 on 2026-10-09 -> mid 573.85
    -> rounded to the nearest 5 -> 575

A row that explains itself is not queried. When it IS wrong, the reply names
the step that is wrong instead of a bare different number, which is the
difference between a conversation and four spreadsheets.

The arithmetic here is recomputed from the same inputs preflight checks, and
both read the rounding settings through `rounding.settings_for`, so the
explanation cannot drift from the figure or from the check.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .rounding import round_to_nearest, settings_for
from .rules import FIXED, PriceRule, adjustment_label

# Statuses carrying a figure worth explaining. The same set preflight reads.
PRICED_STATUSES = ("suggested", "near_match", "derived")

ARROW = " → "

# How deep a chain of rules is followed before giving up. The rulebook
# chains (a report price becomes an FOB, which prices a third region), but a
# cycle in the console's rules would otherwise loop here for ever.
MAX_CHAIN = 6


@dataclass(frozen=True)
class Workings:
    location: str
    price: float | None
    source: str | None
    report_date: str | None
    quoted_low: float | None
    quoted_high: float | None
    steps: tuple[str, ...] = field(default_factory=tuple)
    #: What this derivation actually arrives at, which is the published
    #: figure unless something overwrote it.
    derived_price: float | None = None
    #: How far the two may legitimately differ. Zero for everything read off
    #: a report or adjusted by a fixed amount; one rounding step for a
    #: percentage rule, because the engine applies the percentage to the
    #: UNROUNDED reference and rounds afterwards, while these workings apply
    #: it to the reference's published figure -- the one the client can see
    #: on the row above. The two routes agree exactly for a fixed adjustment
    #: that is a whole number of steps; a percentage can land a step apart,
    #: and that is the arithmetic's imprecision, not a fault in the price.
    tolerance: float = 0.005

    @property
    def line(self) -> str:
        return ARROW.join(self.steps)

    @property
    def reconciles(self) -> bool:
        """Whether the arithmetic reaches the figure that was published.

        False is the Japan case: published at 840 against a quoted 759-791.
        It is stated rather than hidden, because a sheet that explains itself
        must also admit when the explanation does not add up.
        """
        if self.price is None or self.derived_price is None:
            return False

        return abs(self.price - self.derived_price) <= max(self.tolerance, 0.005)


def _figure(value) -> str:
    """A number as a person writes it, not as a float prints."""
    if value is None:
        return "-"

    number = float(value)

    return str(int(number)) if number == int(number) else f"{number:g}"


def _priced(row: dict) -> bool:
    return row.get("status") in PRICED_STATUSES and row.get("suggested_price") is not None


def _rule_for(location: str, rules: list[PriceRule]) -> PriceRule | None:
    for rule in rules:
        if rule.enabled and rule.derived_location == location:
            return rule

    return None


def _adjusted(value: float, rule: PriceRule) -> float:
    if rule.adjustment_kind in FIXED:
        return value + rule.adjustment_value

    return value * (1 + (rule.adjustment_value / 100.0))


def workings_for(
    row: dict,
    *,
    by_location: dict[str, dict],
    rules: list[PriceRule] | None = None,
    default_step=None,
    overrides: dict | None = None,
    _depth: int = 0,
) -> Workings:
    """One price, and every step that produced it."""
    rules = rules or []
    overrides = overrides or {}
    location = row["location"]
    steps: list[str] = []
    running: float | None = None

    rule = _rule_for(location, rules) if row.get("status") == "derived" else None
    tolerance = 0.005

    if rule is not None and _depth < MAX_CHAIN:
        reference = by_location.get(rule.reference_location)

        if reference is not None and _priced(reference):
            # The client's question is never "where did 855 come from"
            # alone; it is "and where did the 835 come from". The whole
            # chain goes out, not just the last link.
            upstream = workings_for(
                reference,
                by_location=by_location,
                rules=rules,
                default_step=default_step,
                overrides=overrides,
                _depth=_depth + 1,
            )
            steps.extend(upstream.steps)

            base = reference["suggested_price"]
            running = _adjusted(base, rule)

            # A percentage applied to a rounded reference is not quite the
            # percentage the engine applied to the unrounded one.
            if rule.adjustment_kind not in FIXED:
                step, _ = settings_for(location, default_step, overrides)
                tolerance = max(tolerance, step or 0)

            steps.append(
                f"{rule.reference_location} {_figure(base)} {adjustment_label(rule)} "
                f"= {_figure(running)}"
            )
        else:
            steps.append(f"derived from {rule.reference_location}, which has no figure")
    else:
        low, high = row.get("suggested_min"), row.get("suggested_max")
        source = row.get("source")
        reported = row.get("price_date")

        if low is None or high is None:
            steps.append(
                f"{source} gave {_figure(row['suggested_price'])}"
                if source
                else "published with no source recorded"
            )
            running = row.get("suggested_price")
        else:
            quoted = (
                _figure(low) if low == high else f"{_figure(low)}-{_figure(high)}"
            )
            said = source or "no source recorded"
            steps.append(f"{said} quoted {quoted}" + (f" on {reported}" if reported else ""))

            running = (low + high) / 2

            # A single-figure assessment has no midpoint worth stating: 893
            # to 893 is 893, and saying so reads like arithmetic that is not
            # happening.
            if low != high:
                steps.append(f"mid {_figure(running)}")

        # fx.convert_rows writes this when a figure arrived in another
        # currency: the rate, its source and its date, which the client asks
        # for by name on the Turkish and Russian rows.
        if row.get("conversion"):
            steps.append(str(row["conversion"]))
            running = row.get("suggested_price")

    step, direction = settings_for(location, default_step, overrides)

    if running is not None and step and step > 0:
        rounded = round_to_nearest(running, step, direction)

        # Only when it actually moves. "Rounded to the nearest 5 -> 825" on a
        # figure that was already 825 is noise on forty rows.
        if abs(rounded - running) >= 0.005:
            steps.append(
                f"rounded {_direction_words(direction)} {_figure(step)} = {_figure(rounded)}"
            )

        running = rounded

    return Workings(
        location=location,
        price=row.get("suggested_price"),
        source=row.get("source"),
        report_date=row.get("price_date"),
        quoted_low=row.get("suggested_min"),
        quoted_high=row.get("suggested_max"),
        steps=tuple(steps),
        derived_price=running,
        tolerance=tolerance,
    )


def _direction_words(direction: str) -> str:
    return {
        "nearest": "to the nearest",
        "up": "up to the next",
        "down": "down to the previous",
    }.get(direction, "to the nearest")


def export_columns() -> list[str]:
    """The sheet's columns, in the order the client reads them: what the
    figure is, where it came from, and whether it adds up."""
    return [
        "Location",
        "Published",
        "Source",
        "Report date",
        "Quoted low",
        "Quoted high",
        "Workings",
        "Checks out",
    ]


def export_rows(
    rows: list[dict],
    *,
    rules: list[PriceRule] | None = None,
    default_step=None,
    overrides: dict | None = None,
) -> list[dict]:
    """One line per published price, ready for a CSV the client can open
    beside the report."""
    by_location = {row["location"]: row for row in rows}
    exported: list[dict] = []

    for row in rows:
        if not _priced(row):
            continue

        result = workings_for(
            row,
            by_location=by_location,
            rules=rules,
            default_step=default_step,
            overrides=overrides,
        )

        exported.append(
            {
                "Location": result.location,
                "Published": result.price,
                "Source": result.source or "",
                "Report date": result.report_date or "",
                "Quoted low": result.quoted_low,
                "Quoted high": result.quoted_high,
                "Workings": result.line,
                "Checks out": "yes" if result.reconciles else "no",
            }
        )

    return exported
