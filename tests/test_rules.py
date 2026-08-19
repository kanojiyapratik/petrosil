"""Reading prices without the model.

This exists to answer "is the crawler reaching the pages?" separately from
"is the model available?" -- with only the AI path, those two failures look
identical from the outside.
"""

from scraper.rules import RuleExtractor

LOCATIONS = ["Gulf Coast", "Europe SN 500 FOB Group I"]
TODAY = "2026-08-19"


def read(text, locations=LOCATIONS):
    return RuleExtractor().extract("https://example.com", text, locations, TODAY)


class TestRuleExtractor:
    def test_reads_a_table_row(self):
        result = read("Crude Oil (Excluding SPR)  424.40\nMotor Gasoline  208.70")

        assert [(row.location, row.price) for row in result.rows] == [
            ("Crude Oil (Excluding SPR)", 424.40),
            ("Motor Gasoline", 208.70),
        ]

    def test_snaps_to_the_site_wording_exactly_as_the_model_path_does(self):
        # Both paths must produce the same shape, or the site would treat
        # a diagnostic run differently from a real one.
        result = read("gulf coast 3.69")

        assert result.rows[0].location == "Gulf Coast"

    def test_ignores_a_line_that_is_plainly_not_a_price(self):
        result = read(
            "Freight rose 4.50 percent\n"
            "Volume was 12.30 million barrels\n"
            "Change on the week 1.20\n"
            "Gulf Coast 3.69"
        )

        assert [row.location for row in result.rows] == ["Gulf Coast"]

    def test_drops_a_price_with_nothing_to_label_it(self):
        assert read("845.00").rows == []

    def test_trims_a_label_that_is_really_a_sentence(self):
        result = read(
            "The national average retail price for regular gasoline across every "
            "region surveyed this week was 4.006"
        )

        assert len(result.rows[0].location) <= 80

    def test_keeps_one_row_per_label(self):
        result = read("Gulf Coast 3.69\nGulf Coast 3.71")

        assert len(result.rows) == 1

    def test_says_plainly_that_it_is_not_publishable(self):
        # Nobody should mistake a diagnostic run for real data.
        result = read("Gulf Coast 3.69")

        assert "not good enough to publish" in (result.notes or "")
        assert result.error is None
        assert result.declined is False
