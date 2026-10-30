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


PERCENT = "percent"
USD = "usd"
EUR = "eur"
INR = "inr"

# A fixed amount, and the currency it is written in. The arithmetic is the
# same for all three -- the amount is added -- because a fixed difference is
# always in the derived price's own currency: Bitumart's Brussels is five
# euros over Antwerp, its packed refinery prices rupees over bulk.
FIXED = {USD: "USD", EUR: "EUR", INR: "INR"}


@dataclass(frozen=True)
class PriceRule:
    id: int
    derived_location: str
    reference_location: str
    adjustment_value: float
    # "percent" -- the client's rulebook is written in percentages -- or a
    # fixed amount per tonne in dollars ("usd"), euros ("eur") or rupees
    # ("inr"), for the locations that sit a fixed amount off their benchmark
    # rather than a fixed proportion.
    adjustment_kind: str = PERCENT
    enabled: bool = True


def adjustment_label(rule: PriceRule) -> str:
    """How an adjustment is written, everywhere it is written.

    The screen, the audit trail and the basis line on a derived price must
    agree: "-10%" and "-25 USD" mean very different things and the editor
    reads them in three different places.
    """
    if rule.adjustment_kind in FIXED:
        return f"{rule.adjustment_value:+g} {FIXED[rule.adjustment_kind]}"

    return f"{rule.adjustment_value:+g}%"


def _adjusted(value: float, rule: PriceRule) -> float:
    if rule.adjustment_kind in FIXED:
        return value + rule.adjustment_value

    return value * (1 + (rule.adjustment_value / 100.0))


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


# Row statuses a rule may fill: nothing found, or an answer with no usable
# figure. A close match and a foreign/unrated figure stay as they are -- the
# first awaits a human, the second is not dollars yet.
FILLABLE = ("no_evidence", "invalid")

# ... and the one it may OVERRIDE. A direct suggestion used to win, which
# meant that whenever the model answered for a location the client prices by
# rule, the rule silently did not run: Brussels published 580 on 16 October
# 2026 instead of Antwerp + 5 EUR = 575, and Iran Bulk 325 instead of its
# benchmark + 15 USD = 330. The site's own instructions warn about exactly
# this in prose -- "a price given directly against the location would bypass
# it" -- and nothing enforced it.
#
# A rule IS the client's price for that location; a figure the model read off
# a page is not a second opinion about it. So the rule wins, and because a
# disagreement means one of the two is wrong about something, the row is
# flagged with both figures rather than quietly replaced.
OVERRIDABLE = ("suggested",)


def apply_rules(rows: list[dict], rules: list[PriceRule]) -> list[dict]:
    """Fills rule-covered locations from their reference's suggested price.

    Only a row the model suggested directly is a usable reference: a close
    match still awaits a human, and arithmetic on top of a guess would
    launder the uncertainty away. A direct suggestion for the derived
    location always beats the rule -- but a model answer WITHOUT a figure
    ("all exports from Russia are banned") is no evidence for pricing, so
    the rule still fills it and the remark is kept for the editor.
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

            fillable = target["status"] in FILLABLE
            overriding = target["status"] in OVERRIDABLE

            if not (fillable or overriding) or reference["status"] not in (
                "suggested",
                "derived",
            ):
                continue

            # Already derived by an earlier pass in this same run; re-deriving
            # would be work for nothing and would re-flag a settled row.
            if overriding and target.get("derived_from"):
                continue

            price = _whole(_adjusted(reference["suggested_price"], rule))

            # A fixed amount can take a low benchmark below zero, and so can a
            # percentage near -100. A price of nothing is not a price:
            # leave the row for the editor rather than staging one.
            if price <= 0:
                continue

            derived_this_pass = True
            remark = target.get("rationale") if target["status"] == "invalid" else None

            # What the model had offered for this location, when it offered
            # anything. Kept before the row is rewritten, so the editor can
            # see what was set aside and decide which of the two is wrong.
            displaced = target["suggested_price"] if overriding else None
            disagrees = displaced is not None and abs(displaced - price) >= 0.005
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
                    "suggested_min": _whole(_adjusted(reference["suggested_min"], rule)),
                    "suggested_max": _whole(_adjusted(reference["suggested_max"], rule)),
                    "suggested_price": price,
                    "change_pct": js_number(change) if change is not None else None,
                    # A rule that had to displace a figure is always worth a
                    # look, however small the move: one of the two readings
                    # of this location is wrong.
                    "flag": (
                        "check"
                        if disagrees or (change is not None and abs(change) >= FLAG_PCT)
                        else None
                    ),
                    "confidence": reference["confidence"],
                    "basis": f"Derived: {rule.reference_location} {adjustment_label(rule)}",
                    "source": reference["source"],
                    "rationale": (
                        f"Calculated from {rule.reference_location} "
                        f"({origin}) {adjustment_label(rule)}."
                        + (
                            f" Your price rule gives {js_number(price)}; the reports were "
                            f"read as {js_number(displaced)} for this location, which this "
                            "rule replaces. Check which is right."
                            if disagrees
                            else ""
                        )
                        + (f" The reports also said: {remark}" if remark else "")
                    ),
                    "derived_from": rule.reference_location,
                    "rule_adjustment": rule.adjustment_value,
                    "rule_kind": rule.adjustment_kind,
                }
            )

        if not derived_this_pass:
            break

    return rows


def _whole(value: float) -> int:
    """Nearest whole USD/MT, half away from zero -- the owner's Math.round."""
    return int(math.floor(value + 0.5)) if value >= 0 else int(math.ceil(value - 0.5))
