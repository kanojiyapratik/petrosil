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
from app.editorial.rules import EUR, PriceRule, apply_rules

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

    def test_an_override_of_zero_exempts_the_location_from_the_site_default(self):
        # The client's Indonesia: printed 896, and 896 it must stay -- the
        # "use the price exactly as it is" choice is stored as a step of 0.
        rows = apply_rounding(draft([suggestion(SINGAPORE, 896, 896)]), 5, {SINGAPORE: 0.0})
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 896
        assert "Rounded" not in (row.get("rationale") or "")

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


class TestARealFigureInTheWrongCurrency:
    """25 Sep 2026: Turkey Domestic EUR was drafted from "TRY 552". 552 was
    printed -- in dollars -- so lira-to-euro gave EUR 9.80."""

    EVIDENCE = [
        {"name": "Turkey", "price": 29084, "price_min": None, "price_max": None, "currency": "TRY"},
        {"name": "Turkey", "price": 600, "price_min": None, "price_max": None, "currency": "USD"},
        {"name": "Turkey", "price": 552, "price_min": None, "price_max": None, "currency": "$/T"},
    ]

    def test_a_dollar_figure_passed_off_as_lira_is_flagged(self):
        from app.editorial.review import unsupported_by_evidence

        rows = draft([suggestion(TURKEY, 552, 552, currency="TRY")])

        assert unsupported_by_evidence(rows, self.EVIDENCE) == {TURKEY}

    def test_the_same_figure_in_its_own_currency_is_trusted(self):
        from app.editorial.review import unsupported_by_evidence

        # No currency on a suggestion means dollars; "$/T" on a checked row too.
        rows = draft([
            suggestion(TURKEY, 29084, 29084, currency="TRY"),
            suggestion(SINGAPORE, 552, 552),
        ])

        assert unsupported_by_evidence(rows, self.EVIDENCE) == set()


def test_the_reading_prompt_asks_where_each_figure_was_printed():
    from app.editorial.reading import READING_PREAMBLE

    flat = " ".join(READING_PREAMBLE.split())
    assert "note must also say WHERE the figure was printed" in flat
    assert '"price map"' in flat


class TestWhichWayAPriceGoes:
    """The rulebook's "closest multiple of 5" is the default, but a handful
    of locations are always taken one way: at a step of 5, 97 is 100 going
    up and 95 going down."""

    def test_nearest_is_the_default_when_no_direction_is_named(self):
        assert round_to_nearest(97, 5) == 95
        assert round_to_nearest(98, 5) == 100

    def test_up_takes_the_next_multiple(self):
        assert round_to_nearest(97, 5, "up") == 100
        assert round_to_nearest(91, 5, "up") == 95

    def test_down_takes_the_one_below(self):
        assert round_to_nearest(97, 5, "down") == 95
        assert round_to_nearest(99, 5, "down") == 95

    def test_a_price_already_on_the_step_never_moves_either_way(self):
        for way in ("nearest", "up", "down"):
            assert round_to_nearest(95, 5, way) == 95

    def test_an_unknown_direction_falls_back_to_nearest(self):
        # An empty column on a row written before this existed, or a value
        # from a hand-edited database -- never a crash, never a silent
        # change of which way a published price goes.
        assert round_to_nearest(97, 5, "") == 95
        assert round_to_nearest(97, 5, None) == 95
        assert round_to_nearest(97, 5, "sideways") == 95

    def test_an_override_can_carry_its_own_direction(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1641, 1641)]), 5, {SINGAPORE: (5, "up")})
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1645

    def test_the_site_default_can_carry_one_too(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1641, 1641)]), (5, "down"))
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert row["suggested_price"] == 1640

    def test_a_locations_direction_beats_the_sites(self):
        rows = apply_rounding(
            draft([suggestion(SINGAPORE, 1641, 1641), suggestion(KOREA, 1641, 1641)]),
            (5, "down"),
            {SINGAPORE: (5, "up")},
        )

        assert next(r for r in rows if r["location"] == SINGAPORE)["suggested_price"] == 1645
        assert next(r for r in rows if r["location"] == KOREA)["suggested_price"] == 1640

    def test_the_rationale_says_which_way_it_went(self):
        rows = apply_rounding(draft([suggestion(SINGAPORE, 1641, 1641)]), (5, "up"))
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert "Rounded up to the next 5" in row["rationale"]

        rows = apply_rounding(draft([suggestion(SINGAPORE, 1641, 1641)]), (5, "down"))
        row = next(r for r in rows if r["location"] == SINGAPORE)

        assert "Rounded down to the previous 5" in row["rationale"]


class TestARuleAndAStepOnTheSameEuroLocation:
    """Bitumart's Brussels: a rule derives it from Antwerp (+5 EUR) and the
    editor then wants a step on it too. Both must take effect, in that
    order -- the rule first, the step on what it produced -- and the euro
    path must not be mistaken for "still needs converting", which is the
    one case apply_rounding deliberately leaves alone.
    """

    ANTWERP = "Belgium - Antwerp Domestic"
    BRUSSELS = "Brussels Domestic"
    PLACES = [ANTWERP, BRUSSELS]
    HOME = {ANTWERP: "EUR", BRUSSELS: "EUR"}
    RULE = PriceRule(
        id=1, derived_location=BRUSSELS, reference_location=ANTWERP,
        adjustment_value=5.0, adjustment_kind=EUR,
    )

    def staged(self, antwerp_price):
        rows = draft(
            [suggestion(self.ANTWERP, antwerp_price, antwerp_price, currency="EUR")],
            locations=self.PLACES,
        )
        # A euro figure for a euro location is left as printed and, crucially,
        # loses its "currency" marker -- it is now this location's own price.
        rows = convert_rows(rows, None, "2026-10-15", home=self.HOME)

        return apply_rules(rows, [self.RULE])

    def test_the_derived_euro_price_is_rounded_by_its_own_step(self):
        rows = self.staged(517)
        brussels = next(r for r in rows if r["location"] == self.BRUSSELS)
        assert brussels["status"] == "derived"
        assert brussels["suggested_price"] == 522  # 517 + 5, not yet stepped
        assert not brussels.get("currency")

        rows = apply_rounding(rows, 5, {self.BRUSSELS: (5, "nearest")})
        brussels = next(r for r in rows if r["location"] == self.BRUSSELS)

        assert brussels["suggested_price"] == 520
        # Both lines survive: where the price came from, and what moved it.
        assert "Calculated from Belgium - Antwerp Domestic" in brussels["rationale"]
        assert "Rounded to the nearest 5" in brussels["rationale"]

    def test_the_step_runs_on_the_derived_price_not_on_the_reference(self):
        # 518 + 5 = 523 -> 525 going up. Rounding the reference first would
        # give 520 + 5 = 525 too, so the direction is what tells them apart:
        # 518 -> 520 (nearest) + 5 = 525, against 523 -> 520 going down.
        rows = self.staged(518)
        rows = apply_rounding(rows, 5, {self.BRUSSELS: (5, "down")})
        brussels = next(r for r in rows if r["location"] == self.BRUSSELS)

        assert brussels["suggested_price"] == 520

    def test_the_reference_keeps_its_own_step_independently(self):
        rows = self.staged(517)
        rows = apply_rounding(rows, 5, {self.BRUSSELS: (5, "up")})

        antwerp = next(r for r in rows if r["location"] == self.ANTWERP)
        brussels = next(r for r in rows if r["location"] == self.BRUSSELS)

        assert antwerp["suggested_price"] == 515  # site default, nearest 5
        assert brussels["suggested_price"] == 525  # 522 -> up to the next 5


class TestAFigureTakenAsPrintedIsNotAnInventedOne:
    """UK South is read from a £/t column and published in euros, on the
    editor's own ruling. The evidence check compares currencies, so the
    right answer -- EUR 465-480 against a checked GBP 465-480 -- came back
    flagged "the AI may have made it up or mixed up the currency". For a
    location the editor has marked "take the figure as printed", a figure
    in the printed currency is the point. The number is still checked.
    """

    EVIDENCE = [
        {"name": "Southern UK", "price": 465, "price_min": 465, "price_max": 480,
         "currency": "GBP"},
    ]

    UK = TURKEY  # any tracked location; the name does not matter here

    def test_the_same_number_in_another_currency_is_accepted(self):
        from app.editorial.review import unsupported_by_evidence

        rows = draft([suggestion(self.UK, 465, 480, currency="EUR")])

        assert unsupported_by_evidence(rows, self.EVIDENCE) == {self.UK}
        assert unsupported_by_evidence(rows, self.EVIDENCE, {self.UK}) == set()

    def test_a_number_no_report_printed_is_still_flagged(self):
        # The currency test is dropped; the figure test is not, or the
        # setting would wave through exactly what this check exists for.
        from app.editorial.review import unsupported_by_evidence

        rows = draft([suggestion(self.UK, 81212, 81212, currency="EUR")])

        assert unsupported_by_evidence(rows, self.EVIDENCE, {self.UK}) == {self.UK}

    def test_other_locations_are_judged_exactly_as_before(self):
        from app.editorial.review import unsupported_by_evidence

        rows = draft([suggestion(SINGAPORE, 465, 480, currency="EUR")])

        assert unsupported_by_evidence(rows, self.EVIDENCE, {self.UK}) == {SINGAPORE}
