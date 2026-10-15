"""From a model's suggested ranges to rows an editor can act on.

The model proposes; nothing it says is trusted. Every row is checked against
the site's own location list, every number is re-derived here (midpoint,
change vs the current price), and anything that fails validation degrades to
a status the preview can show -- never an exception.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import date

from ..price_review.differ import js_number
from ..price_review.summariser import _round2

CONFIDENCES = ("high", "medium", "low")

# The suspected-errors floor: a midpoint this far from the current price is
# not necessarily wrong (the sample sheet's ranges sat 20-100% above), but it
# is exactly the row a human must look at before staging.
FLAG_PCT = 50.0

# The owner's ruling: when a report prints the same item both pre-tax and
# tax-inclusive (BASIC and TOTAL, and the like -- see reading.py's
# READING_PREAMBLE, which is what makes both figures reach here as two
# checked rows with the same name), the pre-tax/basic figure is the default
# price, because price lists are ordinarily quoted ex-tax. The choice is
# never silent -- the model is told to say which figure it used in that
# row's rationale -- and an editor who wants the other figure for a given
# site overrides it in that site's own instructions, which ride on this
# same prompt (see the "Editor's instructions" block below). No tax rate is
# ever hardcoded and no tax is computed or stripped anywhere in this
# module: code, never the model, computes every number that reaches a
# price, and the model is only ever asked to pick which printed figure to
# use, not to do arithmetic on it.

PREAMBLE = """You are a base oil market analyst drafting a price update for a human
editor. Below are one or more market reports, followed by the exact
list of price locations the site tracks.

For each location the reports give evidence about, propose a suggested
price range in USD per metric ton. Use only evidence found in the
reports; skip any location the reports say nothing about rather than
guessing. Never invent a location: every "location" value must be
copied exactly, character for character, from the list given -- the
identical characters, nothing added before, inside or after them. Do
not prefix it with "Table" or "Image", do not repeat or re-punctuate
"Report:", and do not otherwise decorate it. These names are matched
literally by code once you answer, not read by a person: a single word
added around an otherwise correct name breaks that match silently, and
a figure you read correctly is then reported as missing.

Reports write the same location many ways: word order differs, "Group
3" means "Group III", "FOB" may be missing. When the region and grade
clearly refer to a listed location, use the LISTED name -- that is
still an exact match, not an invention. Entries beginning "Report: "
are the report's own benchmark assessments (e.g. its FOB Asia or
Northwestern Europe tables): when a figure is printed as such an
assessment, return it under that entry. Only when the evidence is for
a grade or region that genuinely has no listed counterpart, do not
discard it: include the row with the name exactly as printed in the
report, and a human editor will decide where it belongs.

Two checked rows sometimes carry the same name and differ only in price
and a qualifier in note -- BASIC vs TOTAL, pre-tax vs tax-inclusive, a
discounted price vs a list price, two delivery bases. That is one item
priced on different terms, never two locations and never two figures to
average: use the pre-tax / basic figure as the price
unless the editor's own instructions say otherwise, and say in that
row's rationale which figure you used and why (e.g. "used the BASIC
figure, pre-tax").

Some "Report: " benchmarks are printed in a currency other than USD (for
example Turkey ex-rack prices in Turkish lira, printed like "Tl <amount>/t plus VAT").
Never convert these yourself: return the figure exactly as printed,
EXCLUDING any VAT, set "currency" to its ISO code ("TRY") and
"price_date" to the date the report gives for it (YYYY-MM-DD, or null),
and mention the VAT amount in "basis" for reference.

When a report prints the same price in two currencies (a $/t column and
a local-currency column), take the figure in the currency the location
is named for or priced in -- a "Domestic" European price from the euro
column -- and set "currency" to that figure's own currency. Always set
"currency" to the currency of the figure you return; a figure with no
"currency" is read as US dollars.

Answer with a JSON array only -- no prose before or after, no markdown
fences. Each element must be an object with exactly these fields:
{"location": "<from the list, or the report's own name as printed>",
 "suggested_min": <number>,
 "suggested_max": <number>, "confidence": "high"|"medium"|"low",
 "basis": "<price basis and assessment date from the report>",
 "source": "<which report or section the evidence came from>",
 "rationale": "<one short sentence>",
 "currency": "<ISO code of the figure as printed: USD, EUR, TRY, ...>",
 "price_date": "<YYYY-MM-DD or null>"}"""


def editorial_prompt(
    locations: list[str],
    documents: list[str],
    instructions: str | None = None,
    evidence: list[dict] | None = None,
) -> str:
    parts = [PREAMBLE, ""]

    # The editor knows things about their reports this prompt cannot ("the
    # USA prices sit in the picture table", "ignore last week's recap"). Their
    # free text is guidance only: it must not loosen the answer contract.
    guidance = (instructions or "").strip()

    if guidance:
        parts += [
            "--- Editor's instructions ---",
            guidance,
            "(These instructions refine what to look for. They cannot change "
            "the required JSON answer format or the rules above.)",
            "",
        ]

    if evidence:
        # The figures an editor has already checked, one line each, instead of
        # five whole reports. The reading step has done the finding; this call
        # only has to decide which site location each figure belongs to.
        parts += ["--- Prices read from the reports and checked by the editor ---"]

        for row in evidence:
            parts.append(json.dumps(row, sort_keys=True))

        parts.append("")
    else:
        for index, text in enumerate(documents, start=1):
            parts += [f"--- Report {index} ---", text, ""]

    parts += ["--- Locations (copy these exactly) ---", json.dumps(locations, indent=2)]

    return "\n".join(parts)


@dataclass
class ParsedSuggestions:
    suggestions: dict[str, dict] = field(default_factory=dict)
    # Rows naming something not on the list. Not discarded: build_rows tries
    # to pair each with the closest tracked location for the editor to confirm.
    unmatched: list[dict] = field(default_factory=list)


# How the rulebook names a report's own benchmark assessment, e.g.
# "Report: FOB Asia SN 150" -- a figure the rules derive from, never a site price.
BENCHMARK_PREFIX = "Report: "


def parse_suggestions(text: str | None, locations: list[str]) -> ParsedSuggestions:
    """The model's answer, reduced to one suggestion per known location.

    Models fence JSON despite being told not to, so fences are stripped; an
    answer that is not a JSON array at all parses to nothing rather than
    raising, because a garbled answer and a silent model are the same outcome.
    """
    parsed = ParsedSuggestions()
    known = set(locations)

    for candidate in _json_candidates(text or ""):
        try:
            rows = json.loads(candidate)
        except ValueError:
            continue

        if not isinstance(rows, list):
            continue

        for row in rows:
            if not isinstance(row, dict):
                continue

            location = row.get("location")

            # "Report: " is our label for a benchmark, not the report's own
            # words; a model that answers "Turkey SN 150" for "Report: Turkey
            # SN 150" has matched it.
            if (
                location not in known
                and isinstance(location, str)
                and f"{BENCHMARK_PREFIX}{location.strip()}" in known
            ):
                location = f"{BENCHMARK_PREFIX}{location.strip()}"
                row = {**row, "location": location}

            if location not in known:
                if isinstance(location, str) and location.strip():
                    parsed.unmatched.append(row)

                continue

            parsed.suggestions.setdefault(location, row)

        return parsed

    return parsed


def _json_candidates(text: str):
    stripped = re.sub(r"^\s*```[a-z]*\s*|\s*```\s*$", "", text.strip())

    yield stripped

    start, end = stripped.find("["), stripped.rfind("]")

    if start != -1 and end > start:
        yield stripped[start : end + 1]


# How alike a report's own name and a tracked location must be before the
# editor is asked "close to this — is this correct?". Token overlap, so word
# order, punctuation and filler like "FOB" do not matter; below the bar the
# name really is something the site does not track.
NEAR_MATCH_THRESHOLD = 0.6

# "report" and "table"/"image" are the boilerplate a model wraps around a
# "Report: ..." benchmark name ("Report - Table: ...", "Report: Image
# Table: ...") rather than copying it verbatim -- structural filler, the
# same idea as "FOB" on a location, never part of what the name means.
FILLER_TOKENS = {"fob", "cfr", "cif", "fca", "report", "table", "image"}

# "Group 3" and "Group III" are the same thing in different reports.
ROMAN_DIGITS = {"1": "i", "2": "ii", "3": "iii"}


def _stripped_name(name: str) -> tuple[str, ...]:
    """`name`, lower-cased, de-punctuated and stripped of FILLER_TOKENS,
    keeping the remaining words in their original order.

    This is deliberately not `_tokens()`: `_tokens()` also folds spelling
    variants together ("4cst" / "4 CST", "3" / "III") and drops word order,
    which is exactly the fuzziness that makes two DIFFERENT names look
    alike enough for a near-match. Here the question is narrower and must
    stay strict -- is this THE SAME name, just with filler words added
    around it? -- so no other normalisation is applied, and order still
    matters: "Singapore Group I SN 150" is a reordering of "Singapore SN
    150 FOB Group I" (a near-match, still needing confirmation), not the
    same name with filler added.
    """
    text = re.sub(r"[^a-z0-9]+", " ", (name or "").lower())

    return tuple(token for token in text.split() if token not in FILLER_TOKENS)


UNSUPPORTED_NOTE = (
    "This figure (in this currency) is not among the prices checked from the "
    "reports -- the AI may have made it up or mixed up the currency. Check the "
    "report before saving."
)


def unsupported_by_evidence(
    rows: list[dict], evidence: list[dict], as_printed: set[str] | None = None
) -> set[str]:
    """Locations whose suggested figure appears in none of the checked rows.

    On 24 Sep 2026 the draft priced Turkey Domestic EUR from "TRY 81,212" --
    a number that was in no report, only in an example inside the prompt.
    Every figure the model hands back should be one the editor checked (or
    the midpoint of one's range), so anything else is flagged, not trusted.
    Call on the rows as the model returned them, before any conversion.

    The currency must match too. On 25 Sep 2026 the draft priced Turkey
    Domestic EUR from "TRY 552": 552 was a real figure, but the report
    printed it in dollars -- so the lira-to-euro conversion gave EUR 9.80.

    `as_printed` names the locations the editor has marked "take the figure
    as printed, never convert it", where a figure printed in one currency
    and priced in another is the point rather than a mistake -- UK South,
    read from a £/t column and published in euros. Those are checked on the
    number alone. The number still has to be one the editor checked, which
    is what catches an invented figure; only the currency test is dropped,
    and only where the editor has said it does not apply.
    """
    as_printed = as_printed or set()
    allowed: list[tuple[float, str]] = []

    for entry in evidence:
        currency = _money(entry.get("currency"))
        low, high = entry.get("price_min"), entry.get("price_max")
        allowed += [
            (float(v), currency) for v in (entry.get("price"), low, high) if v is not None
        ]

        if low is not None and high is not None:
            allowed.append(((float(low) + float(high)) / 2, currency))

    def known(value, currency: str) -> bool:
        return value is not None and any(
            money == currency and abs(float(value) - figure) <= max(0.5, abs(figure) * 0.001)
            for figure, money in allowed
        )

    def whatever_the_currency(value) -> bool:
        return value is not None and any(
            abs(float(value) - figure) <= max(0.5, abs(figure) * 0.001)
            for figure, _ in allowed
        )

    def supported(row) -> bool:
        if row["location"] in as_printed:
            return whatever_the_currency(row.get("suggested_min")) or whatever_the_currency(
                row.get("suggested_max")
            )

        currency = _money(row.get("currency"))

        return known(row.get("suggested_min"), currency) or known(
            row.get("suggested_max"), currency
        )

    return {
        row["location"]
        for row in rows
        if row.get("status") in ("suggested", "near_match", "foreign")
        and row.get("suggested_min") is not None
        and not supported(row)
    }


def _money(value) -> str:
    """One spelling per currency, for comparing a suggestion with a checked
    row: no currency means dollars (how the model is told to answer), and a
    report's "$/t" or "US$" is USD too."""
    text = str(value or "").strip().upper()

    if not text or "$" in text or text.startswith("USD"):
        return "USD"

    symbols = {"€": "EUR", "₹": "INR", "RS": "INR", "RS.": "INR", "£": "GBP", "TL": "TRY"}

    return symbols.get(text, text[:3])


def flag_unsupported(rows: list[dict], unsupported: set[str]) -> list[dict]:
    """Flag those rows -- and every price a rule worked out from one of them
    -- for checking. A flagged row is left unticked on the draft screen."""
    marked = set(unsupported)
    grew = True

    while grew:
        grew = False

        for row in rows:
            if row.get("derived_from") in marked and row["location"] not in marked:
                marked.add(row["location"])
                grew = True

    for row in rows:
        if row["location"] in marked and row.get("suggested_price") is not None:
            row["flag"] = "check"

            if UNSUPPORTED_NOTE not in (row.get("rationale") or ""):
                row["rationale"] = " ".join(filter(None, [row.get("rationale"), UNSUPPORTED_NOTE]))

    return rows


SCALE_FACTOR = 5.0
SCALE_SAMPLE = 3


def reject_out_of_scale(
    rows: list[dict], current: dict[str, float], home: dict[str, str] | None = None
) -> list[dict]:
    """Take away any price that cannot be a price at this location's scale.

    On 30 Sep 2026 the draft offered Vietnam CFR FOB at 13 on five runs out
    of five -- a real number from the report (a change or a freight figure),
    so nothing flagged it, and the location had no price yet to compare
    with. A price is measured against the location's own current price, or,
    when it has none, against the middle of the site's other prices in the
    same currency: more than SCALE_FACTOR times off either way, and it is
    not offered at all. Call after rounding, on prices in the location's
    own currency.
    """
    home = {name: code.strip().upper() for name, code in (home or {}).items() if code}
    by_currency: dict[str, list[float]] = {}

    for name, price in current.items():
        if price and price > 0:
            by_currency.setdefault(home.get(name, "USD"), []).append(float(price))

    def typical(currency: str) -> float | None:
        prices = sorted(by_currency.get(currency, []))

        if len(prices) < SCALE_SAMPLE:
            return None

        middle = len(prices) // 2

        return prices[middle] if len(prices) % 2 else (prices[middle - 1] + prices[middle]) / 2

    for row in rows:
        price = row.get("suggested_price")

        if row.get("status") not in ("suggested", "near_match", "derived") or price is None:
            continue

        currency = home.get(row["location"], "USD")
        own = current.get(row["location"])
        reference = float(own) if own and own > 0 else typical(currency)

        if reference is None or reference / SCALE_FACTOR <= price <= reference * SCALE_FACTOR:
            continue

        compared = (
            f"its current price of {js_number(round(reference, 2))}"
            if own and own > 0
            else f"the site's other {currency} prices (typically about {js_number(round(reference))})"
        )
        note = (
            f"{js_number(price)} is far out of line with {compared} -- not a price at this "
            "scale, so nothing is offered. Check the report."
        )
        row["status"] = "invalid"
        row["suggested_price"] = None
        row["flag"] = None
        row["rationale"] = f"{row['rationale']} {note}" if row.get("rationale") else note

    return rows


def build_rows(
    locations: list[str],
    current_prices: dict[str, float],
    parsed: ParsedSuggestions,
) -> list[dict]:
    """One row per tracked location, in the site's order.

    Exact suggestions land first. Before the fuzzy pairing below gets a
    chance to call it a guess, an unmatched row that is the asked name
    itself -- once case, punctuation, whitespace and the filler words above
    are stripped -- is reclaimed as an ordinary suggestion for that name: it
    is not a guess, it is the asked name dressed differently, and a rule may
    derive from it like any other suggested row. A normalised form that
    matches more than one asked name reclaims none of them -- ambiguity is
    not a match, and a wrong reclamation stages a wrong price with no one
    asked. Whatever is left is then paired with the closest tracked location
    and shown as a `near_match` for the editor to confirm, exactly as
    before -- an exact suggestion (reclaimed or not) always beats a near one.
    """
    suggestions = dict(parsed.suggestions)
    by_normalised: dict[tuple[str, ...], list[str]] = {}

    for location in locations:
        by_normalised.setdefault(_stripped_name(location), []).append(location)

    still_unmatched = []

    for candidate in parsed.unmatched:
        reported = str(candidate.get("location") or "").strip()
        normalised = _stripped_name(reported)
        matches = [
            location for location in by_normalised.get(normalised, ())
            if location not in suggestions
        ]

        if normalised and len(matches) == 1:
            suggestions.setdefault(matches[0], candidate)
        else:
            still_unmatched.append(candidate)

    rows = {
        location: _build_row(
            location, current_prices.get(location), suggestions.get(location)
        )
        for location in locations
    }
    taken = set(suggestions)
    location_tokens = {location: _tokens(location) for location in locations}

    for candidate in still_unmatched:
        reported = str(candidate.get("location") or "").strip()
        best, score = None, 0.0

        for location, tokens in location_tokens.items():
            overlap = _overlap(_tokens(reported), tokens)

            if overlap > score:
                best, score = location, overlap

        if best is None or score < NEAR_MATCH_THRESHOLD or best in taken:
            continue

        row = _build_row(best, current_prices.get(best), candidate)

        if row["status"] != "suggested":
            continue

        row["status"] = "near_match"
        row["reported_as"] = reported
        rows[best] = row
        taken.add(best)

    return [rows[location] for location in locations]


def _tokens(name: str) -> frozenset[str]:
    text = re.sub(r"[^a-z0-9]+", " ", (name or "").lower())
    # "4cst" and "4 cst" are the same grade.
    text = re.sub(r"(\d)(cst)", r"\1 \2", text)
    tokens = set()

    for token in text.split():
        if token in FILLER_TOKENS:
            continue

        tokens.add(ROMAN_DIGITS.get(token, token))

    return frozenset(tokens)


def _overlap(a: frozenset[str], b: frozenset[str]) -> float:
    union = a | b

    return len(a & b) / len(union) if union else 0.0


def _build_row(location: str, current: float | None, suggested: dict | None) -> dict:
    row = {
        "location": location,
        "status": "no_evidence",
        "reported_as": None,
        "current_price": js_number(current),
        "suggested_min": None,
        "suggested_max": None,
        "suggested_price": None,
        "change_pct": None,
        "confidence": None,
        "basis": None,
        "source": None,
        "rationale": None,
        "flag": None,
    }

    if suggested is None:
        return row

    confidence = str(suggested.get("confidence") or "").lower()
    row.update(
        {
            "confidence": confidence if confidence in CONFIDENCES else "low",
            "basis": _clean(suggested.get("basis")),
            "source": _clean(suggested.get("source")),
            "rationale": _clean(suggested.get("rationale")),
        }
    )

    low = _positive_number(suggested.get("suggested_min"))
    high = _positive_number(suggested.get("suggested_max"))

    if low is None or high is None:
        row["status"] = "invalid"

        return row

    if low > high:
        low, high = high, low

    midpoint = _round2((low + high) / 2)
    change = _round2(((midpoint - current) / current) * 100) if current else None

    row.update(
        {
            "status": "suggested",
            "suggested_min": js_number(low),
            "suggested_max": js_number(high),
            "suggested_price": js_number(midpoint),
            "change_pct": js_number(change) if change is not None else None,
            "flag": "check" if change is not None and abs(change) >= FLAG_PCT else None,
        }
    )

    # A figure printed in another currency is not a price yet: it is kept as
    # printed and marked `foreign` so nothing treats lira as dollars until
    # fx.convert_rows has divided it by a dated rate.
    currency = _currency(suggested.get("currency"))
    row["currency"] = currency
    row["price_date"] = _iso_date(suggested.get("price_date"))

    if currency is not None:
        row["status"] = "foreign"

    return row


def _currency(value) -> str | None:
    if not isinstance(value, str):
        return None

    code = value.strip().upper()

    if len(code) != 3 or not code.isalpha() or code == "USD":
        return None

    return code


def _iso_date(value) -> str | None:
    if not isinstance(value, str):
        return None

    try:
        return date.fromisoformat(value.strip()[:10]).isoformat()
    except ValueError:
        return None


def _positive_number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None

    try:
        number = float(value)
    except ValueError:
        return None

    if not math.isfinite(number) or number <= 0:
        return None

    return number


def _clean(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None

    return value.strip()[:500]
