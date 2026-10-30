"""The second look: the locations the main pass skipped, asked again alone.

Same failure as the one benchmarks.py was built for, one layer out. Measured
on prod 16.10.2026 (bitumart, draft 48, the 25.09 Argus issue): the main
editorial pass was handed 187 checked rows and 55 names and answered 26.
France North Domestic and Germany North/South/West Domestic came back empty
even though "Northern France 535-545 EUR" and "Northern Germany 525-540 EUR"
were in the evidence -- and re-running the IDENTICAL prompt answered all
four. Nothing was wrong with the prompt or the reading; the model simply
skims a long list and stops short. The editor then sees "not in the reports"
for a price that was there, which is the one failure this screen must not
have.

So the names that came back empty are asked once more, on their own: the
same checked rows, a short list, one answer per name, null allowed. A figure
fills the gap; a null changes nothing. Locations the rulebook derives are
never asked -- a figure here would fill the row and apply_rules, which only
fills what is still empty, would then stay silent.
"""

from __future__ import annotations

import json

from .review import ParsedSuggestions, merge_named

PREAMBLE = """You are a market analyst. Below are ONLY the price lines an editor has
already checked from this week's reports, followed by a short list of the
site's own price locations that a first pass over those same lines returned
nothing for. They are the gaps: each one is either a line someone skimmed
past, or a location this week's reports genuinely do not price.

Return one object for EVERY location in the list, in the same order, whether
or not you find it. When the lines give the figure, fill in the range printed
(a single figure is both min and max); when they genuinely do not, set
"suggested_min" and "suggested_max" to null and say so in "rationale". Never
guess a figure, never estimate one, and never derive one location from
another: a location with no line of its own is a null, not an approximation.
If the editor's instructions say a location is not read from the reports at
all, answer null for it.

The lines carry the reports' own names for places and the list carries the
site's own ("Northern Germany" is this site's "Germany North Domestic",
"South Africa" its "Africa South Rack"). When the region, grade and basis
clearly refer to a listed location, answer under the LISTED name, copied
exactly, character for character. The editor's instructions say which line
and which column each one is read from.

A line that prints the same price twice prints it in two currencies, once
in the local currency or euros and once in dollars. Always set "currency" to
the ISO code of the figure you return; a figure with no "currency" is read
as US dollars.

Answer with a JSON array only -- no prose before or after, no markdown
fences. Each element must be an object with exactly these fields:
{"location": "<the location, copied exactly from the list>",
 "suggested_min": <number or null>,
 "suggested_max": <number or null>, "confidence": "high"|"medium"|"low",
 "basis": "<price basis and assessment date from the lines>",
 "source": "<which report or section the figure came from>",
 "rationale": "<one short sentence>",
 "currency": "<ISO code of the figure as printed: USD, EUR, TRY, ...>",
 "price_date": "<YYYY-MM-DD or null>"}"""


def missed_locations(
    locations: list[str], parsed: ParsedSuggestions, derived: set[str] | None = None
) -> list[str]:
    """The site's locations the main pass returned no row for, in the site's
    own order, minus the ones the rulebook fills itself."""
    skip = derived or set()

    return [
        name
        for name in locations
        if name not in parsed.suggestions and name not in skip
    ]


def second_look_prompt(
    locations: list[str], digest: str, instructions: str | None
) -> str:
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
        "--- Prices read from the reports and checked by the editor ---",
        digest,
        "",
        "--- Locations still to fill (copy these names exactly) ---",
        json.dumps(locations, indent=2),
    ]

    return "\n".join(parts)


def merge_second_look(
    main: ParsedSuggestions, focused: ParsedSuggestions, locations: list[str]
) -> ParsedSuggestions:
    """The second look's figures fill the gaps; its nulls change nothing;
    anything it says about a location that was not asked about is ignored."""
    return merge_named(main, focused, locations)
