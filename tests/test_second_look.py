"""The second look: the locations the main pass simply skipped.

Measured on prod, 16.10.2026 (bitumart, draft 48, the 25.09 Argus issue).
The main editorial pass was given 187 checked rows and 55 names and answered
26 of them: France North Domestic and Germany North/South/West Domestic came
back empty although "Northern France 535-545 EUR" and "Northern Germany
525-540 EUR" were sitting in the evidence. Re-running the IDENTICAL prompt
answered all four -- the same skim that made the benchmark pass necessary
(see benchmarks.py), now on ordinary locations.

So the locations that came back with nothing are asked again on their own:
only the checked rows, only the names that are still empty, one answer per
name, null allowed. A figure fills the gap; a null changes nothing.
"""

import json

from app.editorial.review import parse_suggestions
from app.editorial.secondlook import (
    merge_second_look,
    missed_locations,
    second_look_prompt,
)

LOCATIONS = [
    "France North Domestic",
    "Germany North Domestic",
    "Italy Domestic",
    "India Drums CFR",
]


def answered(*names):
    return parse_suggestions(
        json.dumps(
            [
                {
                    "location": name, "suggested_min": 100, "suggested_max": 110,
                    "confidence": "high", "basis": "table", "source": "report",
                    "rationale": "read",
                }
                for name in names
            ]
        ),
        LOCATIONS,
    )


class TestWhichLocationsGetASecondLook:
    def test_the_ones_the_main_pass_left_empty(self):
        missed = missed_locations(LOCATIONS, answered("Italy Domestic"))

        assert missed == [
            "France North Domestic", "Germany North Domestic", "India Drums CFR",
        ]

    def test_nothing_when_the_main_pass_answered_everything(self):
        assert missed_locations(LOCATIONS, answered(*LOCATIONS)) == []

    def test_a_location_the_rulebook_derives_is_never_asked_again(self):
        # India Drums CFR is the client's own rule (Iran drums + 25). Asking
        # the model for it would fill the row and the rule would then stay
        # silent, because apply_rules only fills what is still empty.
        missed = missed_locations(
            LOCATIONS, answered("Italy Domestic"), derived={"India Drums CFR"}
        )

        assert missed == ["France North Domestic", "Germany North Domestic"]

    def test_the_order_of_the_site_s_own_list_is_kept(self):
        missed = missed_locations(list(reversed(LOCATIONS)), answered())

        assert missed == list(reversed(LOCATIONS))


class TestTheSecondLookPrompt:
    def test_names_every_missed_location_and_allows_null(self):
        prompt = second_look_prompt(
            ["France North Domestic", "Germany North Domestic"],
            "Northern France 535-545 EUR",
            None,
        )

        assert "France North Domestic" in prompt
        assert "Germany North Domestic" in prompt
        assert "Northern France 535-545 EUR" in prompt
        assert "null" in prompt
        # One answer per name, in order -- enumerate-and-fill, not skim.
        assert "EVERY" in prompt

    def test_the_editor_s_instructions_ride_along(self):
        # They are how the model knows "Northern Germany" is this site's
        # "Germany North Domestic" and which column to read.
        prompt = second_look_prompt(
            ["Germany North Domestic"], "Northern Germany 525-540 EUR",
            "Read the EURO column for the European domestic prices.",
        )

        assert "Read the EURO column" in prompt

    def test_it_asks_for_the_currency_of_the_figure_as_printed(self):
        # The four locations this pass exists for are all euro ones; a figure
        # returned without its currency would be read as dollars.
        prompt = second_look_prompt(["Germany North Domestic"], "x", None)

        assert "currency" in prompt


class TestMergingTheSecondLook:
    def test_a_figure_fills_a_location_the_main_pass_missed(self):
        main = answered("Italy Domestic")
        focused = parse_suggestions(
            json.dumps(
                [
                    {
                        "location": "Germany North Domestic", "suggested_min": 525,
                        "suggested_max": 540, "confidence": "high",
                        "basis": "North and central Europe, euro column",
                        "source": "20260925.pdf", "rationale": "Northern Germany",
                        "currency": "EUR",
                    }
                ]
            ),
            LOCATIONS,
        )

        merged = merge_second_look(main, focused, ["Germany North Domestic"])

        assert merged.suggestions["Germany North Domestic"]["suggested_min"] == 525
        assert merged.suggestions["Germany North Domestic"]["currency"] == "EUR"
        assert merged.suggestions["Italy Domestic"]["suggested_min"] == 100

    def test_a_null_answer_erases_nothing(self):
        main = answered("Italy Domestic")
        focused = parse_suggestions(
            json.dumps(
                [
                    {
                        "location": "Italy Domestic", "suggested_min": None,
                        "suggested_max": None, "confidence": "low", "basis": "",
                        "source": "", "rationale": "not in the lines",
                    }
                ]
            ),
            LOCATIONS,
        )

        merged = merge_second_look(main, focused, ["Italy Domestic"])

        assert merged.suggestions["Italy Domestic"]["suggested_min"] == 100

    def test_a_location_that_was_not_asked_about_is_ignored(self):
        main = answered()
        focused = answered("Italy Domestic")

        merged = merge_second_look(main, focused, ["France North Domestic"])

        assert "Italy Domestic" not in merged.suggestions
