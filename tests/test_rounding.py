"""The rounding step the client's rulebook asks for on nearly every line:
"Take Average from Report, round off closest multiple of 5" -- Turkey's own
local-currency line rounds to 10 instead. The average already happens
elsewhere; this is the step that never existed, so every price reaching the
client had to be rounded by hand before publishing.
"""

import json

from app.editorial.fx import convert_rows
from app.editorial.review import build_rows, parse_suggestions
from app.editorial.rounding import apply_rounding, round_to_nearest
from app.editorial.rules import PriceRule, apply_rules

SINGAPORE = "Singapore Bulk FOB"
KOREA = "South Korea FOB"
TURKEY = "Turkey Domestic In Local Currency"
LOCATIONS = [SINGAPORE, KOREA, TURKEY]


def suggestion(location, low, high, **overrides):
    row = {
        "location": location,
        "suggested_min": low,
        "suggested_max": high,
        "confidence": "high",
        "basis": "FOB Asia, 22-Aug-2026",
        "source": "Argus",
        "rationale": "Direct assessment.",
    }
    row.update(overrides)

    return row


def draft(model_rows, current=None, locations=LOCATIONS):
    parsed = parse_suggestions(json.dumps(model_rows), locations)

    return build_rows(locations, current or {}, parsed)


class TestRoundToNearest:
    def test_a_step_of_five_rounds_down(self):
        assert round_to_nearest(1642, 5) == 1640

    def test_a_step_of_five_rounds_up(self):
        assert round_to_nearest(1647, 5) == 1645

    def test_a_step_of_five_on_exactly_a_half_rounds_away_from_zero(self):
        # The owner's worked example, verbatim.
        assert round_to_nearest(1642.5, 5) == 1645

    def test_a_step_of_ten(self):
        assert round_to_nearest(1647, 10) == 1650

    def test_no_step_leaves_the_value_exactly_as_it_is(self):
        assert round_to_nearest(1647, None) == 1647

    def test_a_step_of_zero_means_no_rounding(self):
        assert round_to_nearest(1647, 0) == 1647

    def test_a_negative_step_means_no_rounding_not_a_crash(self):
        assert round_to_nearest(1647, -5) == 1647

    def test_an_empty_step_means_no_rounding(self):
        assert round_to_nearest(1647, "") == 1647


class TestApplyRoundingADirectPrice:
    def test_rounds_the_suggested_price_to_the_site_default(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1640, 1655)]), 5)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        # Midpoint is 1647.5 -> rounds to 1650 on a step of 5.
        assert row["suggested_price"] == 1650

    def test_no_step_configured_leaves_the_price_exactly_as_it_is_now(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1640, 1655)]), None)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1647.5

    def test_a_per_location_override_beats_the_site_default(self):
        # 1636 rounds to 1635 on the site default of 5, but to 1640 on
        # Turkey-style override of 10 -- the override must win.
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1636, 1636)]), 5, {SINGAPORE: 10})
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1640

    def test_a_location_with_no_override_still_gets_the_site_default(self):
        rows = apply_rounding(
            draft([suggestion(SINGAPORE, 1640, 1655), suggestion(KOREA, 1640, 1655)]),
            5,
            {SINGAPORE: 10},
        )
        korea = next(r for r in rows if r["location"] == KOREA)

        assert korea["suggested_price"] == 1650

    def test_the_rationale_names_the_rounding(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1647, 1647)]), 5)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1645
        assert "rounded" in row["rationale"].lower()
        assert "5" in row["rationale"]
        assert "1647" in row["rationale"] or "1,647" in row["rationale"]

    def test_a_price_already_on_the_grid_is_left_alone_and_unremarked(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1645, 1645)]), 5)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1645
        assert row["rationale"] == "Direct assessment."

    def test_a_near_match_is_rounded_too(self):
        candidate = suggestion("Bulk FOB Singapore", 1642, 1652)
        parsed = parse_suggestions(json.dumps([candidate]), LOCATIONS)
        rows = build_rows(LOCATIONS, {}, parsed)
        row = next(r for r in rows if r["location"] == SINGAPORE)
        assert row["status"] == "near_match"

        rows = apply_rounding(rows, 5)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1645

    def test_no_evidence_and_invalid_rows_are_untouched(self):
        rows = apply_rounding(draft([]), 5)

        for row in rows:
            assert row["suggested_price"] is None


class TestApplyRoundingAnFxConvertedPrice:
    def test_a_converted_price_lands_rounded(self):
        rows = draft(
            [suggestion(TURKEY, 81225, 81225, currency="TRY", price_date="2026-08-19")]
        )

        class FakeRates:
            def get(self, currency, on_date):
                from app.editorial.fx import FxRate

                return FxRate(currency="TRY", rate=40.0, rate_date=on_date, source="ECB")

        rows = convert_rows(rows, FakeRates(), "2026-08-19")
        row = next(r for r in rows if r["location"] == TURKEY)
        # 81225 / 40 = 2030.625 -- not yet a multiple of 10.
        assert row["suggested_price"] == 2030.63

        rows = apply_rounding(rows, None, {TURKEY: 10})
        row = next(r for r in rows if r["location"] == TURKEY)

        assert row["suggested_price"] == 2030
        assert "rounded" in row["rationale"].lower()

    def test_a_row_still_needing_a_rate_is_never_rounded_as_if_it_were_usd(self):
        rows = draft(
            [suggestion(TURKEY, 81225, 81225, currency="TRY", price_date="2026-08-19")]
        )

        class NoRates:
            def get(self, currency, on_date):
                return None

        rows = convert_rows(rows, NoRates(), "2026-08-19")
        row = next(r for r in rows if r["location"] == TURKEY)
        assert row["status"] == "needs_rate"

        rows = apply_rounding(rows, 5)
        row = next(r for r in rows if r["location"] == TURKEY)

        assert row["suggested_price"] == 81225


class TestApplyRoundingADerivedPrice:
    RULE = PriceRule(
        id=1, derived_location=KOREA, reference_location=SINGAPORE, adjustment_value=-10.0
    )

    def test_a_derived_price_lands_rounded(self):
        rows = apply_rules(draft([suggestion(SINGAPORE, 1643, 1643)]), [self.RULE])
        row = next(r for r in rows if r["location"] == KOREA)
        # 1643 * 0.9 = 1478.7 -> _whole already rounds this to 1479.
        assert row["suggested_price"] == 1479

        rows = apply_rounding(rows, 5)
        row = next(r for r in rows if r["location"] == KOREA)

        assert row["suggested_price"] == 1480
        assert "rounded" in row["rationale"].lower()
        # The derived price's own audit line must survive alongside the new one.
        assert "Calculated from" in row["rationale"]

    def test_a_derived_price_can_carry_its_own_override(self):
        rows = apply_rules(draft([suggestion(SINGAPORE, 1643, 1643)]), [self.RULE])
        rows = apply_rounding(rows, 5, {KOREA: 10})
        row = next(r for r in rows if r["location"] == KOREA)

        assert row["suggested_price"] == 1480


class TestAFigureThatRoundsToNothing:
    """TRY 145 read off the wrong row became EUR 2.57, and a step of 10 then
    offered 0 as the price to save (11 Sep 2026 Argus, Turkey Domestic EUR)."""

    def test_it_is_unusable_not_a_zero_price(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 2.57, 2.57)]), 10)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["status"] == "invalid"
        assert row["suggested_price"] is None
        assert "far too small" in row["rationale"]
        assert "was 2.57" in row["rationale"]

    def test_a_small_price_that_stays_above_zero_is_still_rounded(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 6, 6)]), 10)
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["status"] == "suggested"
        assert row["suggested_price"] == 10


def test_the_reading_prompt_asks_for_both_currencies_of_a_two_currency_row():
    # The 11 Sep Argus table prints "Turkey 29,084 29,084 nc 600 600": the
    # reading kept only the dollars, and the lira price never reached the
    # euro conversion.
    from app.editorial.reading import READING_PREAMBLE

    assert "Local currency/t" in READING_PREAMBLE
    assert "TRY <a>-<b> AND USD <c>-<d>" in " ".join(READING_PREAMBLE.split())
    # An example printed as real figures gets copied as a price when the
    # report lacks one (81,212 did exactly that on 24 Sep 2026).
    assert "29,084" not in READING_PREAMBLE


class TestAFigureNoReportPrinted:
    """24 Sep 2026: Turkey Domestic EUR was drafted from TRY 81,212 -- a
    number from an example inside the prompt, not from any report."""

    EVIDENCE = [
        {"name": "Turkey", "price": 29084, "price_min": 29084, "price_max": 29084, "currency": "TRY"},
        {"name": "FOB Asia", "price": 1640, "price_min": 1640, "price_max": 1655},
    ]

    def test_an_invented_figure_is_flagged_and_says_why(self):
        from app.editorial.review import flag_unsupported, unsupported_by_evidence

        rows = draft([suggestion(TURKEY, 81212, 81212, currency="TRY")])
        unsupported = unsupported_by_evidence(rows, self.EVIDENCE)
        rows = flag_unsupported(rows, unsupported)
        row = next(r for r in rows if r["location"] == TURKEY)

        assert unsupported == {TURKEY}
        assert row["flag"] == "check"
        assert "not among the prices checked" in row["rationale"]

    def test_a_printed_figure_its_range_end_or_midpoint_is_trusted(self):
        from app.editorial.review import unsupported_by_evidence

        rows = draft([
            suggestion(TURKEY, 29084, 29084, currency="TRY"),
            suggestion(SINGAPORE, 1647.5, 1647.5),  # midpoint of 1640-1655
            suggestion(KOREA, 1600, 1655),          # one end is printed
        ])

        assert unsupported_by_evidence(rows, self.EVIDENCE) == set()

    def test_a_price_worked_out_from_an_invented_figure_is_flagged_too(self):
        from app.editorial.review import flag_unsupported, unsupported_by_evidence

        rule = PriceRule(id=1, derived_location=KOREA, reference_location=SINGAPORE,
                         adjustment_value=-10.0)
        rows = draft([suggestion(SINGAPORE, 1999, 1999)])
        unsupported = unsupported_by_evidence(rows, self.EVIDENCE)
        rows = flag_unsupported(apply_rules(rows, [rule]), unsupported)
        korea = next(r for r in rows if r["location"] == KOREA)

        assert korea["flag"] == "check"
        assert "not among the prices checked" in korea["rationale"]
