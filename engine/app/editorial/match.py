"""AI-assisted matching of crawler findings to tracked locations.

Pages label prices their own way ("Base Oil SN500 EX Kandla ₹/Ltr"); the site
tracks "India SN 500 CFR Group I". A person can usually tell whether they are
the same thing -- the model proposes the pairing and, crucially, the caution
("the page is in rupees per litre") so the person confirms with open eyes.
The model proposes; only a human stages.
"""

from __future__ import annotations

import json

from .review import _json_candidates

PROMPT = """You pair prices found on web pages with the price locations a site
tracks. For each finding below, say which tracked location it most
likely belongs to, or null when none fits (a different product, a
future, an index).

The site's prices are all in USD per metric ton. A different currency,
unit, city or delivery basis is NOT a reason to answer null: when the
product and grade match a tracked location, propose it, and state the
difference plainly in the caution -- the number cannot be used as-is
and the reader must know. Answer null ONLY when the product itself is
different: crude oil, a future, an index, a percentage, a non-base-oil
product. Example: "Base Oil N500 EX Delhi ₹/KG" matches "India SN 500
CFR Group I" with the caution "price is in rupees per kilogram, the
site tracks USD per metric ton".

Answer with a JSON array only, one object per finding:
{"id": <the finding's id>, "match": "<a tracked location, exactly as
listed, or null>", "caution": "<one short sentence, or empty>"}"""


def build_match_prompt(findings: list[dict], locations: list[str]) -> str:
    return "\n".join(
        [
            PROMPT,
            "",
            "Findings:",
            json.dumps(
                [
                    {"id": f["id"], "label": f["location"], "price": f.get("price")}
                    for f in findings
                ],
                ensure_ascii=False,
                indent=2,
            ),
            "",
            "Tracked locations (copy exactly):",
            json.dumps(locations, indent=2),
        ]
    )


def parse_match_answer(
    text: str | None, valid_ids: set[int], locations: list[str]
) -> dict[int, dict]:
    """The model's pairings, reduced to ids we asked about and locations that
    exist. An invented location becomes no-match with the caution kept; a
    garbled answer is simply no matches."""
    known = set(locations)

    for candidate in _json_candidates(text or ""):
        try:
            rows = json.loads(candidate)
        except ValueError:
            continue

        if not isinstance(rows, list):
            continue

        matches: dict[int, dict] = {}

        for row in rows:
            if not isinstance(row, dict):
                continue

            try:
                finding_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue

            if finding_id not in valid_ids:
                continue

            match = row.get("match")
            caution = str(row.get("caution") or "").strip()[:300]

            matches[finding_id] = {
                "match": match if isinstance(match, str) and match in known else None,
                "caution": caution,
            }

        return matches

    return {}
