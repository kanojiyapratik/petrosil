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

from ..price_review.differ import js_number
from ..price_review.summariser import _round2

CONFIDENCES = ("high", "medium", "low")

# The suspected-errors floor: a midpoint this far from the current price is
# not necessarily wrong (the sample sheet's ranges sat 20-100% above), but it
# is exactly the row a human must look at before staging.
FLAG_PCT = 50.0

PREAMBLE = """You are a base oil market analyst drafting a price update for a human
editor. Below are one or more market reports, followed by the exact
list of price locations the site tracks.

For each location the reports give evidence about, propose a suggested
price range in USD per metric ton. Use only evidence found in the
reports; skip any location the reports say nothing about rather than
guessing. Never invent a location: every "location" value must be
copied exactly, character for character, from the list given.

Reports write the same location many ways: word order differs, "Group
3" means "Group III", "FOB" may be missing. When the region and grade
clearly refer to a listed location, use the LISTED name -- that is
still an exact match, not an invention. Only when the evidence is for
a grade or region that genuinely has no listed counterpart, do not
discard it: include the row with the name exactly as printed in the
report, and a human editor will decide where it belongs.

Answer with a JSON array only -- no prose before or after, no markdown
fences. Each element must be an object with exactly these fields:
{"location": "<from the list, or the report's own name as printed>",
 "suggested_min": <number>,
 "suggested_max": <number>, "confidence": "high"|"medium"|"low",
 "basis": "<price basis and assessment date from the report>",
 "source": "<which report or section the evidence came from>",
 "rationale": "<one short sentence>"}"""


def editorial_prompt(locations: list[str], documents: list[str]) -> str:
    parts = [PREAMBLE, ""]

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

FILLER_TOKENS = {"fob", "cfr", "cif", "fca"}

# "Group 3" and "Group III" are the same thing in different reports.
ROMAN_DIGITS = {"1": "i", "2": "ii", "3": "iii"}


def build_rows(
    locations: list[str],
    current_prices: dict[str, float],
    parsed: ParsedSuggestions,
) -> list[dict]:
    """One row per tracked location, in the site's order.

    Exact suggestions land first; each unmatched row is then paired with the
    closest tracked location and shown as a `near_match` for the editor to
    confirm -- an exact suggestion always beats a near one.
    """
    rows = {
        location: _build_row(
            location, current_prices.get(location), parsed.suggestions.get(location)
        )
        for location in locations
    }
    taken = set(parsed.suggestions)
    location_tokens = {location: _tokens(location) for location in locations}

    for candidate in parsed.unmatched:
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

    return row


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
