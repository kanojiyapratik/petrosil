"""Derived prices: the rulebook, applied by code.

Most of the site's locations never appear in any market report -- they have
always been calculated from the handful of benchmarks the reports do quote
("South Korea FOB = Singapore FOB - 10%"). The owner's ruling is explicit:
the model extracts only the source prices, and this arithmetic is the
server's job -- cheaper, deterministic, and auditable. The rules live in the
console's database so the percentages can change without touching a prompt.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..price_review.differ import js_number
from ..price_review.summariser import _round2
from .review import FLAG_PCT


@dataclass(frozen=True)
class PriceRule:
    id: int
    derived_location: str
    reference_location: str
    adjustment_pct: float
    enabled: bool = True


def benchmark_names(rules: list[PriceRule], site_locations: list[str]) -> list[str]:
    """References that are report figures rather than site locations.

    The client's first layer: even the "extracted" prices are a report
    benchmark minus a discount ("Europe Domestic = report NWE - 20%"). Such a
    reference is asked of the model like any location, derived from like any
    row, but never staged -- it is not a price the site publishes.
    """
    known = set(site_locations)
    names: list[str] = []

    for rule in rules:
        if not rule.enabled:
            continue

        if rule.reference_location not in known and rule.reference_location not in names:
            names.append(rule.reference_location)

    return names


def apply_rules(rows: list[dict], rules: list[PriceRule]) -> list[dict]:
    """Fills rule-covered locations from their reference's suggested price.

    Only a row the model suggested directly is a usable reference: a close
    match still awaits a human, and arithmetic on top of a guess would
    launder the uncertainty away. A direct suggestion for the derived
    location always beats the rule.
    """
    by_location = {row["location"]: row for row in rows}

    # The rulebook chains: the report gives a domestic price, a rule turns it
    # into FOB, and another rule prices a third region off that FOB. Passes
    # repeat until nothing new derives; each pass can only add, so the loop
    # ends. A derived price is deterministic arithmetic on a direct one, so
    # deriving from it launders nothing -- unlike a near-match, which stays
    # ineligible.
    for _pass in range(max(len(rules), 1)):
        derived_this_pass = False

        for rule in rules:
            if not rule.enabled:
                continue

            target = by_location.get(rule.derived_location)
            reference = by_location.get(rule.reference_location)

            if target is None or reference is None:
                continue

            if target["status"] != "no_evidence" or reference["status"] not in (
                "suggested",
                "derived",
            ):
                continue

            derived_this_pass = True
            factor = 1 + (rule.adjustment_pct / 100.0)
            price = _whole(reference["suggested_price"] * factor)
            # A reference that was converted from another currency carries
            # its conversion, and the audit line for the derived price must
            # show it: the client wants the lira figure, the rate and its
            # date on the Russian price, not only on the Turkish one.
            origin = (
                f"{reference['suggested_price']} = {reference['conversion']}"
                if reference.get("conversion")
                else f"{reference['suggested_price']}"
            )
            change = (
                _round2(((price - target["current_price"]) / target["current_price"]) * 100)
                if target["current_price"]
                else None
            )

            target.update(
                {
                    "status": "derived",
                    "suggested_min": _whole(reference["suggested_min"] * factor),
                    "suggested_max": _whole(reference["suggested_max"] * factor),
                    "suggested_price": price,
                    "change_pct": js_number(change) if change is not None else None,
                    "flag": "check" if change is not None and abs(change) >= FLAG_PCT else None,
                    "confidence": reference["confidence"],
                    "basis": f"Derived: {rule.reference_location} {rule.adjustment_pct:+g}%",
                    "source": reference["source"],
                    "rationale": (
                        f"Calculated from {rule.reference_location} "
                        f"({origin}) {rule.adjustment_pct:+g}%."
                    ),
                    "derived_from": rule.reference_location,
                    "rule_pct": rule.adjustment_pct,
                }
            )

        if not derived_this_pass:
            break

    return rows


def _whole(value: float) -> int:
    """Nearest whole USD/MT, half away from zero -- the owner's Math.round."""
    return int(math.floor(value + 0.5)) if value >= 0 else int(math.ceil(value - 0.5))
