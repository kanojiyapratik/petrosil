"""The check that runs before a sheet leaves the building.

Four rounds of mismatch files went back and forth with the client between 8
and 21 October 2026, and the same dozen rows were queried every time. Going
through the 16 October round by hand against Argus issue 26-41 turned up six
faults that were all visible from data already on this machine:

  * Brussels Domestic published 580 when the console's own rule says
    Antwerp + 5 EUR, and Antwerp was published at 570;
  * Iran Bulk and Iran Drums published 325 and 410 when their rules
    (Argus + 15 USD) give 330 and 415;
  * Singapore Bulk published 840 and South Korea 825 when bitumart rounds
    to the NEAREST 5 and the midpoints were 837 and 822 -- 835 and 820;
  * Japan FOB published 840 when the report quoted 759-791.

None of those needed the client, the report, or a second opinion: each one
is a published figure contradicting either its own rule, its own rounding
setting, or its own quoted range. This module is that argument, in code.
"""

from app.editorial.preflight import preflight
from app.editorial.rules import EUR, PERCENT, USD, PriceRule


def priced(location, low, high, price, **overrides):
    """A row as the analyse route leaves it: a range, a published figure."""
    row = {
        "location": location,
        "status": "suggested",
        "suggested_min": low,
        "suggested_max": high,
        "suggested_price": price,
        "source": "Argus Bitumen 26-41",
        "basis": "fob",
        "rationale": "Direct assessment.",
        "price_date": None,
        "currency": None,
    }
    row.update(overrides)

    return row


def derived(location, reference, price, low=None, high=None, **overrides):
    return priced(
        location,
        low if low is not None else price,
        high if high is not None else price,
        price,
        status="derived",
        derived_from=reference,
        **overrides,
    )


def rule(derived_location, reference, value, kind=USD, enabled=True):
    return PriceRule(
        id=1,
        derived_location=derived_location,
        reference_location=reference,
        adjustment_value=value,
        adjustment_kind=kind,
        enabled=enabled,
    )


def check(rows, **kwargs):
    options = {
        "rules": [],
        "default_step": 5,
        "overrides": {},
        "price_date": "2026-10-16",
    }
    options.update(kwargs)

    return preflight(rows, **options)


def checks_of(findings):
    return sorted({finding.check for finding in findings})


def about(findings, location):
    return [finding for finding in findings if finding.location == location]


class TestAClearSheet:
    def test_says_nothing_when_every_figure_holds_up(self):
        rows = [priced("Taiwan FOB", 820, 830, 825)]

        assert check(rows) == []

    def test_ignores_a_row_that_carries_no_price(self):
        rows = [priced("Iraq Drums FOB", None, None, None, status="no_evidence")]

        assert check(rows) == []

    def test_ignores_a_figure_still_printed_in_another_currency(self):
        # fx.convert_rows has not turned it into a USD suggestion yet, so
        # neither the step nor the range means what this check would read.
        rows = [priced("Turkey Domestic", 31020, 31020, 31020, currency="TRY")]

        assert check(rows) == []


class TestADerivedPriceAgainstItsRule:
    def test_passes_when_it_follows_the_rule(self):
        rows = [
            priced("Belgium - Antwerp Domestic", 568, 572, 570),
            derived("Brussels Domestic", "Belgium - Antwerp Domestic", 575),
        ]

        assert check(rows, rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)]) == []

    def test_reports_brussels_published_five_over_its_rule(self):
        rows = [
            priced("Belgium - Antwerp Domestic", 568, 572, 570),
            derived("Brussels Domestic", "Belgium - Antwerp Domestic", 580),
        ]

        findings = check(
            rows, rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)]
        )

        assert checks_of(findings) == ["rule"]
        assert findings[0].location == "Brussels Domestic"
        assert findings[0].expected == 575
        assert findings[0].actual == 580

    def test_says_what_the_rule_required_so_an_editor_need_not_look_it_up(self):
        rows = [
            priced("Belgium - Antwerp Domestic", 568, 572, 570),
            derived("Brussels Domestic", "Belgium - Antwerp Domestic", 580),
        ]

        finding = check(
            rows, rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)]
        )[0]

        assert "Belgium - Antwerp Domestic" in finding.detail
        assert "+5 EUR" in finding.detail

    def test_reports_both_iran_rows(self):
        rows = [
            priced("Argus Iran bulk fob", 308.6, 320, 315),
            priced("Argus Iran drums fob", 390, 410, 400),
            derived("Iran Bulk FOB", "Argus Iran bulk fob", 325),
            derived("Iran Drums FOB", "Argus Iran drums fob", 410),
        ]

        findings = check(
            rows,
            rules=[
                rule("Iran Bulk FOB", "Argus Iran bulk fob", 15),
                rule("Iran Drums FOB", "Argus Iran drums fob", 15),
            ],
        )

        assert [finding.location for finding in findings] == ["Iran Bulk FOB", "Iran Drums FOB"]
        assert [finding.expected for finding in findings] == [330, 415]

    def test_allows_a_percentage_rule_the_slack_that_double_rounding_costs(self):
        # The rules engine runs on unrounded references and both figures are
        # rounded afterwards, so a percentage cannot be reproduced exactly
        # from the rounded reference. A fixed adjustment that is a whole
        # number of steps can, and is held to it.
        rows = [
            priced("Singapore SN 150 FOB Group I", 1515, 1525, 1520),
            derived("Korea TOBS FOB Group II/ II+", "Singapore SN 150 FOB Group I", 1370),
        ]

        findings = check(
            rows,
            rules=[rule("Korea TOBS FOB Group II/ II+", "Singapore SN 150 FOB Group I", -10, PERCENT)],
        )

        assert findings == []

    def test_still_reports_a_percentage_rule_that_is_badly_out(self):
        rows = [
            priced("Singapore SN 150 FOB Group I", 1515, 1525, 1520),
            derived("Korea TOBS FOB Group II/ II+", "Singapore SN 150 FOB Group I", 1450),
        ]

        findings = check(
            rows,
            rules=[rule("Korea TOBS FOB Group II/ II+", "Singapore SN 150 FOB Group I", -10, PERCENT)],
        )

        assert checks_of(findings) == ["rule"]

    def test_leaves_a_switched_off_rule_alone(self):
        rows = [
            priced("Belgium - Antwerp Domestic", 568, 572, 570),
            derived("Brussels Domestic", "Belgium - Antwerp Domestic", 580),
        ]

        findings = check(
            rows,
            rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR, enabled=False)],
        )

        assert findings == []

    def test_says_nothing_when_the_reference_has_no_price_to_check_against(self):
        rows = [
            priced("Belgium - Antwerp Domestic", None, None, None, status="no_evidence"),
            derived("Brussels Domestic", "Belgium - Antwerp Domestic", 580),
        ]

        findings = check(
            rows, rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)]
        )

        assert [f.check for f in findings] == []


class TestRoundingAgainstTheSiteSettings:
    def test_passes_a_midpoint_rounded_to_the_nearest_step(self):
        rows = [priced("Thailand FOB", 820, 835, 830)]

        assert check(rows) == []

    def test_reports_singapore_rounded_up_when_the_site_rounds_to_nearest(self):
        rows = [priced("Singapore Bulk FOB", 832, 842, 840)]

        findings = check(rows)

        assert checks_of(findings) == ["rounding"]
        assert findings[0].expected == 835
        assert findings[0].actual == 840

    def test_reports_south_korea_the_same_way(self):
        rows = [priced("South Korea FOB", 817, 827, 825)]

        findings = check(rows)

        assert about(findings, "South Korea FOB")[0].expected == 820

    def test_allows_rounding_up_where_the_location_is_set_to_round_up(self):
        rows = [priced("Singapore Bulk FOB", 832, 842, 840)]

        assert check(rows, overrides={"Singapore Bulk FOB": (5, "up")}) == []

    def test_leaves_an_unrounded_location_on_its_exact_figure(self):
        # Indonesia is configured with a step of 0: the report prints one
        # figure and the client takes it as it is.
        rows = [priced("Indonesia (Rack)", 893, 893, 893)]

        assert check(rows, overrides={"Indonesia (Rack)": 0}) == []

    def test_reports_a_figure_that_is_not_on_the_step_at_all(self):
        rows = [priced("Greece FOB*", 571.6, 576.1, 573)]

        findings = check(rows)

        assert checks_of(findings) == ["rounding"]
        assert findings[0].expected == 575

    def test_reads_a_direction_carried_on_the_site_default(self):
        # The analyse route passes the site's default as a (step, direction)
        # pair, the same shape apply_rounding takes. A site set to round up
        # must not be told off for rounding up.
        rows = [priced("Singapore Bulk FOB", 832, 842, 840)]

        assert check(rows, default_step=(5, "up")) == []

    def test_still_checks_a_site_default_given_as_a_pair(self):
        rows = [priced("Singapore Bulk FOB", 832, 842, 840)]

        findings = check(rows, default_step=(5, "nearest"))

        assert checks_of(findings) == ["rounding"]
        assert findings[0].expected == 835

    def test_reads_the_step_of_ten_that_turkey_uses(self):
        rows = [priced("Turkey Domestic EUR", 561, 569, 565)]

        findings = check(rows, overrides={"Turkey Domestic EUR": (10, "nearest")})

        assert findings[0].expected == 570


class TestAPriceAgainstItsOwnRange:
    def test_passes_a_figure_inside_the_range_it_was_quoted_from(self):
        rows = [priced("Taiwan FOB", 820, 830, 825)]

        assert check(rows) == []

    def test_reports_japan_published_far_above_what_the_report_quoted(self):
        rows = [priced("Japan FOB", 759, 791, 840)]

        findings = check(rows)

        assert "range" in checks_of(findings)
        assert about(findings, "Japan FOB")[0].actual == 840

    def test_forgives_a_figure_one_rounding_step_outside_the_range(self):
        # 893-893 rounded to the nearest 5 is 895, which is outside its own
        # range by construction. That is the rounding doing its job.
        rows = [priced("Indonesia (Rack)", 893, 893, 895)]

        assert check(rows) == []


class TestHowWideTheQuotedRangeIs:
    """A range too wide to be one assessment.

    The 22 October run read South Korea FOB as "314.3-550" and published the
    midpoint, 430, with high confidence and not one finding against it. Every
    check passed honestly: 430 really is inside 314.3-550, the step is right,
    the source is recorded. The range itself was the thing that was wrong --
    two unrelated figures off different lines, read as one assessment.

    Nothing asked whether the range could be real. Every genuine range on
    that sheet was inside 4.2% (Japan's 759-791, the widest); South Korea's
    high was 75% above its low.
    """

    def spread(self, low, high):
        price = round((low + high) / 2)

        return [
            f.check
            for f in preflight(
                [priced("South Korea FOB", low, high, price)],
                rules=[],
                default_step=None,
                overrides={},
                price_date=None,
            )
        ]

    def test_a_range_too_wide_to_be_one_assessment_is_flagged(self):
        assert "quoted range" in self.spread(314.3, 550)

    def test_the_widest_real_range_on_the_sheet_is_not_flagged(self):
        # Japan FOB, 759-791: 4.2% and entirely legitimate.
        assert "quoted range" not in self.spread(759, 791)

    def test_an_ordinary_range_is_not_flagged(self):
        assert "quoted range" not in self.spread(832, 842)

    def test_a_single_figure_assessment_is_not_flagged(self):
        # Bahrain and Indonesia print one figure, which arrives as low == high.
        assert "quoted range" not in self.spread(893, 893)

    def test_it_says_how_wide_the_range_was(self):
        findings = preflight(
            [priced("South Korea FOB", 314.3, 550, 430)],
            rules=[],
            default_step=None,
            overrides={},
            price_date=None,
        )
        detail = next(f.detail for f in findings if f.check == "quoted range")

        assert "314.3" in detail and "550" in detail
        assert "75%" in detail

    def test_it_is_a_warning_and_not_a_blocker(self):
        # It cannot be proved wrong from the data -- a violent week is a real
        # thing -- so it is for an editor to look at, not a refusal to ship.
        findings = preflight(
            [priced("South Korea FOB", 314.3, 550, 430)],
            rules=[],
            default_step=None,
            overrides={},
            price_date=None,
        )

        assert next(f.severity for f in findings if f.check == "quoted range") == "warning"


class TestWhereAPriceCameFrom:
    def test_reports_a_published_figure_with_no_source(self):
        rows = [priced("Japan FOB", 759, 791, 775, source=None)]

        assert "provenance" in checks_of(check(rows))

    def test_reports_a_published_figure_with_no_quoted_range_behind_it(self):
        rows = [priced("Japan FOB", None, None, 840)]

        assert "provenance" in checks_of(check(rows))

    def test_does_not_ask_a_derived_row_for_a_report_range(self):
        # A derived price is arithmetic on another row; its evidence is the
        # rule, which the rule check already proves.
        rows = [
            priced("Singapore Bulk FOB", 832, 842, 835),
            derived("Singapore Drum FOB", "Singapore Bulk FOB", 855, low=None, high=None),
        ]

        findings = check(
            rows, rules=[rule("Singapore Drum FOB", "Singapore Bulk FOB", 20)]
        )

        assert findings == []


class TestHowOldTheReportIs:
    def test_says_nothing_about_a_report_from_the_same_week(self):
        rows = [priced("Taiwan FOB", 820, 830, 825, price_date="2026-10-16")]

        assert check(rows) == []

    def test_reports_a_run_built_on_last_week_s_issue(self):
        rows = [priced("Taiwan FOB", 820, 830, 825, price_date="2026-10-09")]

        findings = check(rows)

        assert checks_of(findings) == ["report_date"]
        assert "2026-10-09" in findings[0].detail

    def test_warns_rather_than_blocks_because_a_quiet_week_is_legitimate(self):
        rows = [priced("Taiwan FOB", 820, 830, 825, price_date="2026-10-09")]

        assert check(rows)[0].severity == "warning"

    def test_says_nothing_when_the_report_printed_no_date(self):
        rows = [priced("Taiwan FOB", 820, 830, 825, price_date=None)]

        assert check(rows) == []

    def test_reports_each_stale_date_once_however_many_rows_carry_it(self):
        rows = [
            priced("Taiwan FOB", 820, 830, 825, price_date="2026-10-09"),
            priced("Thailand FOB", 820, 835, 830, price_date="2026-10-09"),
            priced("China South Drums CFR", 825, 835, 830, price_date="2026-10-09"),
        ]

        assert len(check(rows)) == 1


class TestTheOrderFindingsComeBackIn:
    def test_puts_what_must_not_ship_above_what_merely_wants_looking_at(self):
        rows = [
            priced("Taiwan FOB", 820, 830, 825, price_date="2026-10-09"),
            priced("Singapore Bulk FOB", 832, 842, 840),
        ]

        findings = check(rows)

        assert [finding.severity for finding in findings] == ["blocker", "warning"]


class TestTheSixteenthOfOctoberTwentyTwentySix:
    """The round that started this, as it actually went out."""

    def rows(self):
        return [
            # Correct, and must stay quiet.
            priced("Africa East CFR", 723, 733, 730),
            priced("Africa North CFR", 619, 629, 625),
            priced("Africa West CFR", 763, 773, 770),
            priced("China South Drums CFR", 825, 835, 830),
            priced("Taiwan FOB", 820, 830, 825),
            priced("Thailand FOB", 820, 835, 830),
            priced("Greece FOB*", 571.6, 576.1, 575),
            priced("Indonesia (Rack)", 893, 893, 893),
            # The six faults.
            priced("Singapore Bulk FOB", 832, 842, 840),
            priced("South Korea FOB", 817, 827, 825),
            priced("Japan FOB", 759, 791, 840),
            priced("Belgium - Antwerp Domestic", 568, 572, 570),
            derived("Brussels Domestic", "Belgium - Antwerp Domestic", 580),
            priced("Argus Iran bulk fob", 308.6, 320, 315),
            derived("Iran Bulk FOB", "Argus Iran bulk fob", 325),
            priced("Argus Iran drums fob", 390, 410, 400),
            derived("Iran Drums FOB", "Argus Iran drums fob", 410),
        ]

    def findings(self):
        return check(
            self.rows(),
            rules=[
                rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR),
                rule("Iran Bulk FOB", "Argus Iran bulk fob", 15),
                rule("Iran Drums FOB", "Argus Iran drums fob", 15),
            ],
            overrides={"Indonesia (Rack)": 0},
        )

    def test_catches_every_fault_the_hand_check_found(self):
        flagged = {finding.location for finding in self.findings()}

        assert flagged == {
            "Singapore Bulk FOB",
            "South Korea FOB",
            "Japan FOB",
            "Brussels Domestic",
            "Iran Bulk FOB",
            "Iran Drums FOB",
        }

    def test_leaves_the_rows_that_were_right_alone(self):
        flagged = {finding.location for finding in self.findings()}

        for location in ("Taiwan FOB", "Thailand FOB", "China South Drums CFR", "Indonesia (Rack)"):
            assert location not in flagged

    def test_every_one_of_them_blocks_the_sheet(self):
        assert all(finding.severity == "blocker" for finding in self.findings())
