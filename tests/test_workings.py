"""Every price, with the arithmetic that produced it.

The half of the October 2026 mismatch problem that preflight does not solve.
The same dozen rows were queried in all four rounds, and they were all rows
whose figure is not printed anywhere in the report -- a midpoint, a rounded
midpoint, a rule applied to another row, a converted currency. The client
opens the Argus PDF, searches for 575, does not find it, and asks. They are
not being careless; they genuinely cannot check those numbers.

So each price states its own derivation, in the client's own terms, and the
sheet that goes out carries it. A row that explains itself is not queried,
and when it IS wrong the reply names the step that is wrong instead of a
bare different number.
"""

from app.editorial.workings import export_columns, export_rows, workings_for
from app.editorial.rules import EUR, PERCENT, USD, PriceRule


def row(location, low, high, price, **overrides):
    base = {
        "location": location,
        "status": "suggested",
        "suggested_min": low,
        "suggested_max": high,
        "suggested_price": price,
        "source": "Argus Bitumen 26-41",
        "basis": "fob",
        "rationale": "",
        "price_date": "2026-10-09",
        "currency": None,
    }
    base.update(overrides)

    return base


def derived_row(location, reference, price, **overrides):
    return row(location, None, None, price, status="derived", derived_from=reference, **overrides)


def rule(derived_location, reference, value, kind=USD):
    return PriceRule(
        id=1,
        derived_location=derived_location,
        reference_location=reference,
        adjustment_value=value,
        adjustment_kind=kind,
        enabled=True,
    )


def working(rows, location, rules=None, default_step=5, overrides=None):
    return workings_for(
        next(r for r in rows if r["location"] == location),
        by_location={r["location"]: r for r in rows},
        rules=rules or [],
        default_step=default_step,
        overrides=overrides or {},
    )


class TestAPriceReadStraightOffAReport:
    def test_names_the_report_the_range_and_the_date(self):
        result = working([row("Singapore Bulk FOB", 832, 842, 835)], "Singapore Bulk FOB")

        assert "Argus Bitumen 26-41" in result.line
        assert "832-842" in result.line
        assert "2026-10-09" in result.line

    def test_shows_the_midpoint_it_took(self):
        result = working([row("Singapore Bulk FOB", 832, 842, 835)], "Singapore Bulk FOB")

        assert "mid 837" in result.line

    def test_shows_the_rounding_that_finished_it(self):
        result = working([row("Singapore Bulk FOB", 832, 842, 835)], "Singapore Bulk FOB")

        assert "nearest 5" in result.line
        assert result.line.rstrip().endswith("835")

    def test_does_not_invent_a_midpoint_for_a_single_figure_assessment(self):
        result = working([row("Indonesia (Rack)", 893, 893, 893)], "Indonesia (Rack)", overrides={"Indonesia (Rack)": 0})

        assert "mid" not in result.line
        assert "893" in result.line

    def test_says_nothing_about_rounding_when_the_figure_did_not_move(self):
        result = working([row("Taiwan FOB", 820, 830, 825)], "Taiwan FOB")

        assert "rounded" not in result.line.lower()

    def test_says_so_when_no_source_was_recorded(self):
        result = working([row("Japan FOB", 759, 791, 775, source=None)], "Japan FOB")

        assert "no source" in result.line.lower()


class TestAPriceADerivationRuleProduced:
    def test_names_the_reference_its_figure_and_the_adjustment(self):
        rows = [
            row("Singapore Bulk FOB", 832, 842, 835),
            derived_row("Singapore Drums FOB", "Singapore Bulk FOB", 855),
        ]

        result = working(
            rows, "Singapore Drums FOB", rules=[rule("Singapore Drums FOB", "Singapore Bulk FOB", 20)]
        )

        assert "Singapore Bulk FOB" in result.line
        assert "835" in result.line
        assert "+20 USD" in result.line
        assert result.line.rstrip().endswith("855")

    def test_writes_a_euro_rule_in_euros(self):
        rows = [
            row("Belgium - Antwerp Domestic", 568, 572, 570),
            derived_row("Brussels Domestic", "Belgium - Antwerp Domestic", 575),
        ]

        result = working(
            rows, "Brussels Domestic", rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)]
        )

        assert "+5 EUR" in result.line

    def test_writes_a_percentage_rule_as_a_percentage(self):
        rows = [
            row("Singapore SN 150", 1515, 1525, 1520),
            derived_row("Korea TOBS", "Singapore SN 150", 1370),
        ]

        result = working(rows, "Korea TOBS", rules=[rule("Korea TOBS", "Singapore SN 150", -10, PERCENT)])

        assert "-10%" in result.line

    def test_carries_the_reference_s_own_workings_so_the_chain_is_whole(self):
        # The client's question is never "where did 855 come from" alone; it
        # is "where did 855 come from, and where did the 835 come from".
        rows = [
            row("Singapore Bulk FOB", 832, 842, 835),
            derived_row("Singapore Drums FOB", "Singapore Bulk FOB", 855),
        ]

        result = working(
            rows, "Singapore Drums FOB", rules=[rule("Singapore Drums FOB", "Singapore Bulk FOB", 20)]
        )

        assert "832-842" in result.line
        assert "mid 837" in result.line


class TestAConvertedPrice:
    def test_keeps_the_conversion_the_rate_and_its_date(self):
        conversion = "TRY 31,020 ÷ 34.5000 TRY/USD (ECB rate of 16.10.26) = USD 899.13"
        rows = [row("Turkey Domestic", 31020, 31020, 900, conversion=conversion)]

        result = working(rows, "Turkey Domestic", overrides={"Turkey Domestic": (10, "nearest")})

        assert "ECB rate of 16.10.26" in result.line
        assert "34.5000" in result.line


class TestWhetherTheWorkingsReachThePublishedFigure:
    def test_says_it_reconciles_when_the_arithmetic_lands_on_the_price(self):
        assert working([row("Taiwan FOB", 820, 830, 825)], "Taiwan FOB").reconciles is True

    def test_says_it_does_not_when_the_published_figure_is_something_else(self):
        # 16 October: Japan published at 840 against a quoted 759-791.
        assert working([row("Japan FOB", 759, 791, 840)], "Japan FOB").reconciles is False

    def test_reports_the_figure_its_own_arithmetic_reaches(self):
        result = working([row("Japan FOB", 759, 791, 840)], "Japan FOB")

        assert result.derived_price == 775
        assert result.price == 840


class TestTheSheetThatGoesToTheClient:
    def test_has_a_column_for_every_part_of_the_argument(self):
        assert export_columns() == [
            "Location",
            "Published",
            "Source",
            "Report date",
            "Quoted low",
            "Quoted high",
            "Workings",
            "Checks out",
        ]

    def test_writes_one_line_per_priced_location(self):
        rows = [
            row("Taiwan FOB", 820, 830, 825),
            row("Thailand FOB", 820, 835, 830),
        ]

        exported = export_rows(rows, rules=[], default_step=5, overrides={})

        assert [line["Location"] for line in exported] == ["Taiwan FOB", "Thailand FOB"]
        assert exported[0]["Published"] == 825
        assert exported[0]["Quoted low"] == 820
        assert exported[0]["Source"] == "Argus Bitumen 26-41"

    def test_marks_a_row_whose_arithmetic_does_not_reach_its_price(self):
        exported = export_rows(
            [row("Japan FOB", 759, 791, 840)], rules=[], default_step=5, overrides={}
        )

        assert exported[0]["Checks out"] == "no"

    def test_marks_a_row_that_does(self):
        exported = export_rows(
            [row("Taiwan FOB", 820, 830, 825)], rules=[], default_step=5, overrides={}
        )

        assert exported[0]["Checks out"] == "yes"

    def test_leaves_out_a_location_with_no_price_to_explain(self):
        rows = [
            row("Taiwan FOB", 820, 830, 825),
            row("Iraq Drums FOB", None, None, None, status="no_evidence"),
        ]

        exported = export_rows(rows, rules=[], default_step=5, overrides={})

        assert [line["Location"] for line in exported] == ["Taiwan FOB"]


class TestTheSixteenthOfOctoberExplainedToTheClient:
    """The rows that were queried in every round, finally stating their case."""

    def rows(self):
        return [
            row("Greece FOB*", 571.6, 576.1, 575),
            row("Taiwan FOB", 820, 830, 825),
            row("Indonesia (Rack)", 893, 893, 893),
            row("Singapore Bulk FOB", 832, 842, 835),
            derived_row("Singapore Drums FOB", "Singapore Bulk FOB", 855),
        ]

    def line_for(self, location):
        return working(
            self.rows(),
            location,
            rules=[rule("Singapore Drums FOB", "Singapore Bulk FOB", 20)],
            overrides={"Indonesia (Rack)": 0},
        ).line

    def test_greece_explains_the_575_nobody_could_find_in_the_pdf(self):
        line = self.line_for("Greece FOB*")

        assert "571.6-576.1" in line
        assert "mid 573.85" in line
        assert "nearest 5" in line
        assert line.rstrip().endswith("575")

    def test_indonesia_explains_why_it_is_not_rounded(self):
        assert "893" in self.line_for("Indonesia (Rack)")

    def test_singapore_drums_explains_the_twenty_dollars(self):
        line = self.line_for("Singapore Drums FOB")

        assert "+20 USD" in line
        assert "855" in line


class TestAPercentageRuleAndDoubleRounding:
    """The engine derives from the UNROUNDED reference and rounds both
    figures afterwards; these workings derive from the reference's published
    figure, because that is the one the client can see on the row above.
    For a fixed adjustment that is a whole number of steps the two routes
    agree exactly. For a percentage they can differ by a step, and that is
    the arithmetic's own imprecision, not a fault in the price.
    """

    def rows(self, published):
        return [
            row("Singapore SN 150", 1515, 1525, 1520),
            derived_row("Korea TOBS", "Singapore SN 150", published),
        ]

    def test_a_percentage_row_a_step_out_still_checks_out(self):
        # 1520 - 10% = 1368 -> nearest 5 is 1370; the engine, working from an
        # unrounded 1520.0, could land a step away.
        result = working(
            self.rows(1365), "Korea TOBS",
            rules=[rule("Korea TOBS", "Singapore SN 150", -10, PERCENT)],
        )

        assert result.reconciles is True

    def test_a_percentage_row_badly_out_does_not(self):
        result = working(
            self.rows(1450), "Korea TOBS",
            rules=[rule("Korea TOBS", "Singapore SN 150", -10, PERCENT)],
        )

        assert result.reconciles is False

    def test_a_fixed_rule_is_still_held_to_the_figure_exactly(self):
        rows = [
            row("Belgium - Antwerp Domestic", 568, 572, 570),
            derived_row("Brussels Domestic", "Belgium - Antwerp Domestic", 580),
        ]

        result = working(
            rows, "Brussels Domestic",
            rules=[rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )

        assert result.reconciles is False
