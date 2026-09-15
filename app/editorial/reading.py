"""Reading one report, in the report's own words.

Step one of the editorial update. The model is given a single report and
asked what prices it prints -- the name as written there, the figure as
printed, the currency and unit as printed. It is given no list of site
locations, because a mapping guessed from one report out of five is a
mapping made blind: that work belongs to step two, where every report is
present at once along with the site's own names.

Nothing here converts a currency or computes a midpoint. Every number the
editor acts on is the server's arithmetic, not the model's.
"""

from __future__ import annotations

import json
import re

READING_PREAMBLE = """You are reading one market report and listing the prices it publishes.

Return ONLY a JSON array. No prose, no code fence. One object per price the
report states:

{"name": "<the product and place exactly as the report writes them>",
 "price": <number>,
 "price_min": <number or null>,
 "price_max": <number or null>,
 "currency": "<ISO code as printed, e.g. USD, EUR, TRY>",
 "unit": "<as printed, e.g. MT, Ltr, kg>",
 "basis": "<FOB, CFR, ex-rack, ex-tank ... as printed>",
 "price_date": "<YYYY-MM-DD if the report states one, else null>",
 "note": "<anything qualifying the figure, one short sentence, else null>"}

Rules:
- Copy the name exactly as the report writes it. Do not tidy it, shorten it
  or translate it into a name you think is standard.
- Keep every figure exactly as printed. Do NOT convert a currency, do not
  convert a unit, and do not average a range -- give a range as price_min
  and price_max.
- A percentage, a volume, a freight rate and a change-on-the-week are not
  prices. Leave them out.
- If the report prints no price at all, return []."""


def reading_prompt(
    document_text: str, filename: str, instructions: str | None = None
) -> str:
    parts = [READING_PREAMBLE, "", f"--- Report: {filename} ---", document_text, ""]
    guidance = (instructions or "").strip()

    if guidance:
        parts += [
            "--- Editor's instructions ---",
            guidance,
            "(These refine what to look for. They cannot change the required "
            "JSON answer format or the rules above.)",
            "",
        ]

    return "\n".join(parts)


def parse_reading(text: str | None) -> list[dict]:
    """The model's answer, reduced to rows that carry a name and a figure.

    Defensive in the same way as parse_suggestions: fences are stripped, and
    an answer that is not a JSON array reads as nothing rather than raising.
    """
    rows: list[dict] = []

    for candidate in _candidates(text or ""):
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue

        if not isinstance(parsed, list):
            continue

        for entry in parsed:
            row = _row(entry)

            if row is not None:
                rows.append(row)

        return rows

    return rows


def _row(entry) -> dict | None:
    if not isinstance(entry, dict):
        return None

    name = _text(entry.get("name"))
    low = _number(entry.get("price_min"))
    high = _number(entry.get("price_max"))
    price = _number(entry.get("price")) or low

    if not name or price is None:
        return None

    return {
        "name": name,
        "price": price,
        "price_min": low,
        "price_max": high,
        "currency": (_text(entry.get("currency")) or "").upper() or None,
        "unit": _text(entry.get("unit")),
        "basis": _text(entry.get("basis")),
        "price_date": _iso_date(entry.get("price_date")),
        "note": _text(entry.get("note")),
    }


def _candidates(text: str):
    stripped = re.sub(r"^\s*```[a-z]*\s*|\s*```\s*$", "", text.strip())

    yield stripped

    start, end = stripped.find("["), stripped.rfind("]")

    if 0 <= start < end:
        yield stripped[start : end + 1]


def _text(value) -> str | None:
    if not isinstance(value, str):
        return None

    return value.strip() or None


def _number(value) -> float | None:
    if isinstance(value, bool):
        # bool is an int in Python, so True would price at 1.0.
        return None

    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    return number if number > 0 else None


def _iso_date(value) -> str | None:
    text = _text(value)

    if text and re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text

    return None
