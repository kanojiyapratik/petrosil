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
from datetime import date

# The model is asked for currency "as printed", and reports print symbols
# and abbreviations as often as ISO codes -- a rupee sign, "Rs.", a euro
# sign. FX conversion downstream keys off the ISO code, so a row that says
# "₹" instead of "INR" is a row the conversion cannot act on: it never
# matches a rate table keyed by ISO code. This is a deterministic lookup,
# not arithmetic and not a judgement about the price itself -- code, never
# the model, computes every number that reaches a price, and this touches
# no number. A symbol this table does not know is left exactly as printed
# rather than guessed at.
_CURRENCY_SYMBOLS = {
    "₹": "INR",
    "RS": "INR",
    "RS.": "INR",
    "$": "USD",
    "€": "EUR",
    "£": "GBP",
}


def _normalise_currency(value: str) -> str:
    """An ISO code as printed passes straight through; a known symbol maps
    to its ISO code; anything else -- an unknown symbol or abbreviation --
    is left exactly as printed rather than guessed at."""
    return _CURRENCY_SYMBOLS.get(value, value)


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
- basis is not optional. Carry the delivery basis in basis exactly as the
  report prints it -- "Ex Mumbai Refinery", "Ex Sewree Installation, Mumbai",
  "Ex Koyali Installation / Baroda Bitumen COD", "FOB", "CFR", "ex-rack".
  Some reports price the very same item at several depots or on several
  terms -- the same product name priced five different ways is a real,
  measured case -- and basis together with note is the ONLY thing that
  tells those rows apart. Leaving basis empty on a row like that makes the
  figure unusable: nothing downstream can say which price belongs to which
  place. If the report truly states no basis for a price, leave basis null
  rather than guessing one -- but check first, because a delivery term or
  place printed anywhere near the figure belongs there.
- currency is not optional either. Copy it exactly as printed (a symbol,
  an abbreviation, an ISO code -- whatever the report uses).
- A percentage, a volume, a freight rate and a change-on-the-week are not
  prices. Leave them out.
- Some reports print more than one figure for the same item: pre-tax and
  tax-inclusive, BASIC and TOTAL, a discounted price and a list price, two
  delivery bases. When that happens, return one row PER figure -- do not
  merge them, do not pick one, do not average them -- and put whatever
  distinguishes that column in note, in the report's own words (for
  example "BASIC", "TOTAL incl. GST", "PREVIOUS"). The name stays exactly
  as the report writes it either way; the qualifier belongs in note, never
  folded into the name.
- A table that prices each row in two currencies side by side -- a
  "Local currency/t" column group next to a "$/t" one -- prints TWO prices
  per row. Return both: one row in the local currency and one in dollars,
  each with its own range. "Local currency" is not a code: give the ISO
  code of that row's country (Turkey TRY, Italy/Spain/France EUR, UK GBP)
  and put "Local currency/t" in note. Leaving the local figure out loses a
  price the report states -- a row "Turkey <a> <b> nc <c> <d>" under those
  two headings is TRY <a>-<b> AND USD <c>-<d>. (Letters, not numbers: an
  example figure is never a price. Only copy numbers the report prints.)
- Reports print the same place in several tables -- a domestic table, an
  export table, a front-page price map -- and the row name alone ("Turkey")
  cannot tell those figures apart. So note must also say WHERE the figure
  was printed: the table's title and section as the report words them
  (e.g. "Mediterranean bitumen prices - Domestic prices, ex-works"), or
  "price map" / "chart" for a figure printed on a map or a chart rather
  than in a table.
- basis and note answer different questions and BOTH must be filled when
  the report supports them: basis says WHERE or on WHAT TERMS a price
  applies, note says WHICH COLUMN of a multi-column table it came from.
  A report can need one, the other, or both on the same row. Filling one
  is never a reason to leave the other empty.
- If the report prints no price at all, return []."""


# How much of a report goes into one reading. The Argus weekly runs to
# about 63,000 characters, and asked for all of it at once the model reads
# the first few pages properly and then loses interest: on 15 Oct 2026 one
# reading of it returned 60 rows, every one of them from pages 3 to 5, and
# the Asia, Mediterranean and Sub-Saharan tables -- two thirds of the issue
# -- were simply not there. Nothing failed and nothing was truncated; the
# answer was valid JSON that stopped early. Earlier runs of the same file
# had dropped single lines the same way (South China coast, Taiwan).
#
# This is the same lesson the page pictures already taught (see
# routes_reading.py, where they are read on their own rather than appended
# to the report): a short prompt is read, a long one is skimmed. 15,000
# characters is roughly four or five Argus pages -- a few tables, which the
# model handles completely -- and cuts the weekly into about five readings.
READING_CHUNK_CHARS = 15_000

# "Issue 26-39 | Friday 25 September 2026 Page 9 of 19" -- the footer every
# page of the Argus report carries, and the natural place to cut.
_PAGE_BREAK = re.compile(r"(?=Page\s+\d+\s+of\s+\d+)")


def split_for_reading(text: str, limit: int = READING_CHUNK_CHARS) -> list[str]:
    """One report, cut into pieces each small enough to be read whole.

    Cuts on page footers where the report has them and on line endings
    where it does not, never inside a line: half a table row is a figure
    without its name. Pages are packed up to `limit` so a short report is
    still one reading, and a single page longer than the limit is left
    whole rather than broken -- a table split down the middle would lose
    more than the long prompt costs.
    """
    body = text or ""

    if len(body) <= limit:
        return [body] if body.strip() else []

    pieces = [piece for piece in _PAGE_BREAK.split(body) if piece]

    if len(pieces) < 2:
        pieces = _by_lines(body, limit)

    chunks: list[str] = []
    current = ""

    for piece in pieces:
        if current and len(current) + len(piece) > limit:
            chunks.append(current)
            current = piece
        else:
            current += piece

    if current.strip():
        chunks.append(current)

    return [chunk for chunk in chunks if chunk.strip()]


def _by_lines(text: str, limit: int) -> list[str]:
    """A report with no page footers -- a docx, a spreadsheet, a scan's
    transcription -- cut on line endings instead."""
    pieces: list[str] = []
    current = ""

    for line in text.splitlines(keepends=True):
        if current and len(current) + len(line) > limit:
            pieces.append(current)
            current = line
        else:
            current += line

    if current:
        pieces.append(current)

    return pieces


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

    currency = (_text(entry.get("currency")) or "").upper() or None

    return {
        "name": name,
        "price": price,
        "price_min": low,
        "price_max": high,
        "currency": _normalise_currency(currency) if currency else None,
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
    """A date the DATE column will take, or nothing.

    The shape alone is not enough: a hallucinated "2025-02-30" matches
    YYYY-MM-DD and is not a day. It used to travel straight into the insert,
    where psycopg raised -- 500ing the whole reading after every AI call in
    the batch had already been paid for. A bad date costs the date; the row
    keeps its price.
    """
    text = _text(value)

    if not text or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return None

    try:
        date.fromisoformat(text)
    except ValueError:
        return None

    return text
