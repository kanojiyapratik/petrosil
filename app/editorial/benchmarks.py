"""The focused benchmark pass: a second, small model call for the figures the
rulebook derives from.

Why it exists (measured 2026-09-01 on the client's 19.08 Lube Report): the
main editorial prompt is the whole report -- ~60k characters, nearly all news
prose -- with 58 names to fill listed at the end. OpenAI models skim it:
three identical gpt-4o runs returned 8/8, 7/8 and 5/8 of the eight benchmarks
(FOB Asia, Ex-tank Singapore, Turkey ex-rack), gpt-4o-mini 5-6/8. Every
missed benchmark is a Singapore or Russia price the site never gets.

So the benchmarks are asked for again, differently: code keeps only the
price-bearing lines of the reports (a line of context each side), the model
is given only the benchmark names, and it must answer once per name -- null
when the figure is genuinely absent. Enumerate-and-fill, not skim. A figure
from this pass beats the main pass for a benchmark; a null never erases one.
"""

from __future__ import annotations

import json
import re

from .review import ParsedSuggestions

# A line that carries a price: "$1,270/t", "Tl 81,212.00/t", "USD 1,480",
# "1,290/t-1,330/t", "€2,040/mt". Deliberately broad -- an extra crude-oil
# line costs a few tokens; a dropped benchmark line costs a price.
PRICE_LINE = re.compile(
    r"([$€£₹]\s?\d[\d,]*"
    r"|\d[\d,]*(?:\.\d+)?\s?/\s?(?:t|mt|ton|tonne|bbl|gal|l|ltr)\b"
    r"|\b(?:usd|eur|gbp|try|tl|rmb|cny|inr|rs|aed|sar)\b\.?\s?\d"
    r"|\d\s?(?:usd|eur|gbp|try|tl|rmb|cny|inr)\b)",
    re.I,
)

CONTEXT_LINES = 1

PREAMBLE = """You are a base oil market analyst. Below are ONLY the price-bearing
lines extracted from one or more market reports (a line of context is kept
around each), followed by a short list of benchmark assessments to find.

Return one object for EVERY benchmark in the list, in the same order, whether
or not you find it. When the lines give the figure, fill in the range printed
(a single figure is both min and max); when they genuinely do not, set
"suggested_min" and "suggested_max" to null and say so in "rationale". Never
guess a figure and never derive one benchmark from another.

Reports name things loosely: "SN150" is "SN 150", "Solvent neutral 150" is
"SN 150", "FOB Asia Group I SN150" is the "FOB Asia SN 150" benchmark,
"Ex-tank Singapore ... Bright stock" is the "Ex-tank Singapore Bright Stock"
benchmark, "ex rack Izmir" prices are the "Turkey" benchmarks.

Some benchmarks are printed in a currency other than USD (for example Turkey
ex-rack prices in Turkish lira, "Tl 81,212.00/t plus VAT"). Never convert
these yourself: return the figure exactly as printed, EXCLUDING any VAT, set
"currency" to its ISO code ("TRY") and "price_date" to the date the report
gives for it (YYYY-MM-DD, or null), and mention the VAT amount in "basis".
USD figures need no "currency".

Answer with a JSON array only -- no prose before or after, no markdown
fences. Each element must be an object with exactly these fields:
{"location": "<the benchmark name, copied exactly from the list>",
 "suggested_min": <number or null>,
 "suggested_max": <number or null>, "confidence": "high"|"medium"|"low",
 "basis": "<price basis and assessment date from the report>",
 "source": "<which report or section the figure came from>",
 "rationale": "<one short sentence>",
 "currency": "<ISO code when not USD, else omit>",
 "price_date": "<YYYY-MM-DD or null>"}"""


def price_digest(documents: list[str]) -> str:
    """The price-bearing lines of each report, each with its neighbours.

    Returns "" when no report has a price line at all, so the caller can skip
    the call rather than ask the model about nothing.
    """
    parts: list[str] = []

    for index, text in enumerate(documents, start=1):
        lines = text.splitlines()
        keep: set[int] = set()

        for at, line in enumerate(lines):
            if PRICE_LINE.search(line):
                keep.update(range(at - CONTEXT_LINES, at + CONTEXT_LINES + 1))

        chosen = [lines[at] for at in sorted(keep) if 0 <= at < len(lines) and lines[at].strip()]

        if chosen:
            parts += [f"--- Report {index} ---", *chosen, ""]

    return "\n".join(parts).strip()


def benchmark_prompt(benchmarks: list[str], digest: str, instructions: str | None) -> str:
    parts = [PREAMBLE, ""]
    guidance = (instructions or "").strip()

    if guidance:
        parts += [
            "--- Editor's instructions ---",
            guidance,
            "(These instructions refine what to look for. They cannot change "
            "the required JSON answer format or the rules above.)",
            "",
        ]

    parts += [
        "--- Price lines from the reports ---",
        digest,
        "",
        "--- Benchmarks to find (copy these names exactly) ---",
        json.dumps(benchmarks, indent=2),
    ]

    return "\n".join(parts)


def _has_figure(row: dict) -> bool:
    return row.get("suggested_min") is not None and row.get("suggested_max") is not None


def merge_benchmarks(
    main: ParsedSuggestions, focused: ParsedSuggestions, benchmarks: list[str]
) -> ParsedSuggestions:
    """The focused pass's figures win for benchmark names; its nulls change
    nothing; anything it says about a non-benchmark is ignored."""
    merged = ParsedSuggestions(
        suggestions=dict(main.suggestions), unmatched=list(main.unmatched)
    )

    for name in benchmarks:
        row = focused.suggestions.get(name)

        if row is not None and _has_figure(row):
            merged.suggestions[name] = row

    return merged
