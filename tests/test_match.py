"""AI-assisted matching of crawler findings to tracked locations.

A found price like "Base Oil SN500 EX Kandla ₹/Ltr" is not a tracked location,
but a human can usually tell which one it belongs to. The model proposes the
match and a caution; the human confirms in a picker. The model never stages
anything.
"""

import json

from app.editorial.match import build_match_prompt, parse_match_answer

FINDINGS = [
    {"id": 61, "location": "Base Oil SN500 EX Kandla ₹/Ltr", "price": 186},
    {"id": 62, "location": "Brent Crude Futures", "price": 90},
]

LOCATIONS = ["India SN 500 CFR Group I", "India SN 150 CFR Group I"]


class TestBuildMatchPrompt:
    def test_carries_findings_and_tracked_locations_and_demands_json(self):
        prompt = build_match_prompt(FINDINGS, LOCATIONS)

        assert "Base Oil SN500 EX Kandla" in prompt
        assert "India SN 500 CFR Group I" in prompt
        assert "JSON" in prompt

    def test_warns_about_currencies_and_units(self):
        prompt = build_match_prompt(FINDINGS, LOCATIONS)

        assert "USD per metric ton" in prompt


class TestParseMatchAnswer:
    def test_reads_matches_and_cautions(self):
        answer = json.dumps(
            [
                {
                    "id": 61,
                    "match": "India SN 500 CFR Group I",
                    "caution": "Price is in ₹ per litre; the site tracks USD per metric ton.",
                },
                {"id": 62, "match": None, "caution": "Crude futures, not a base oil price."},
            ]
        )

        matches = parse_match_answer(answer, {61, 62}, LOCATIONS)

        assert matches[61]["match"] == "India SN 500 CFR Group I"
        assert "litre" in matches[61]["caution"]
        assert matches[62]["match"] is None

    def test_an_invented_location_or_id_is_dropped(self):
        answer = json.dumps(
            [
                {"id": 61, "match": "Atlantis SN 500", "caution": ""},
                {"id": 999, "match": LOCATIONS[0], "caution": ""},
            ]
        )

        matches = parse_match_answer(answer, {61, 62}, LOCATIONS)

        assert matches[61]["match"] is None
        assert 999 not in matches

    def test_a_garbled_answer_is_no_matches_not_a_crash(self):
        assert parse_match_answer("the market rose", {61}, LOCATIONS) == {}
        assert parse_match_answer(None, {61}, LOCATIONS) == {}
