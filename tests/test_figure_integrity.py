"""The two holes that let October 2026's wrong prices through.

Both were found by working the 16 October round back against Argus issue
26-41, and both are about where a figure is ALLOWED to come from.

1. The client's rulebook lost to the model. apply_rules only filled a row
   the model had left empty, so when the model answered for a location that
   has a rule, the rule silently did not run. Brussels published 580 instead
   of Antwerp + 5 EUR = 575; Iran Bulk published 325 instead of benchmark +
   15 USD = 330. The site instructions already warn about this in prose --
   "a price given directly against the location would bypass it" -- and
   nothing enforced it.

2. The evidence check was location-blind. It asked "is this number printed
   somewhere in the reports?", pooling every figure from every report row,
   so a figure belonging to one location vouched for another. Japan
   published 840 against a printed 759-791, and 840 is a real number in that
   issue -- it appears in the Singapore commentary.
"""

from app.editorial.review import unsupported_by_evidence
from app.editorial.rules import EUR, USD, PriceRule, apply_rules


def rule(derived_location, reference, value, kind=USD, enabled=True):
    return PriceRule(
        id=1,
        derived_location=derived_location,
        reference_location=reference,
        adjustment_value=value,
        adjustment_kind=kind,
        enabled=enabled,
    )


def row(location, price, status="suggested", **overrides):
    base = {
        "location": location,
        "status": status,
        "suggested_min": price,
        "suggested_max": price,
        "suggested_price": price,
        "current_price": None,
        "confidence": "high",
        "basis": "",
        "source": "Argus",
        "rationale": "",
        "flag": None,
    }
    base.update(overrides)

    return base


def by_location(rows):
    return {r["location"]: r for r in rows}


class TestTheClientsRulebookWins:
    def test_a_rule_runs_even_when_the_model_answered_for_that_location(self):
        rows = apply_rules(
            [row("Belgium - Antwerp Domestic", 570), row("Brussels Domestic", 580)],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )

        assert by_location(rows)["Brussels Domestic"]["suggested_price"] == 575

    def test_the_iran_rows_come_out_at_the_benchmark_plus_the_premium(self):
        rows = apply_rules(
            [
                row("Argus Iran bulk fob", 315),
                row("Iran Bulk FOB", 325),
                row("Argus Iran drums fob", 400),
                row("Iran Drums FOB", 410),
            ],
            [
                rule("Iran Bulk FOB", "Argus Iran bulk fob", 15),
                rule("Iran Drums FOB", "Argus Iran drums fob", 15),
            ],
        )
        found = by_location(rows)

        assert found["Iran Bulk FOB"]["suggested_price"] == 330
        assert found["Iran Drums FOB"]["suggested_price"] == 415

    def test_the_row_is_flagged_so_the_disagreement_is_not_silent(self):
        rows = apply_rules(
            [row("Belgium - Antwerp Domestic", 570), row("Brussels Domestic", 580)],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )
        brussels = by_location(rows)["Brussels Domestic"]

        assert brussels["flag"] == "check"

    def test_the_rationale_names_both_figures(self):
        rows = apply_rules(
            [row("Belgium - Antwerp Domestic", 570), row("Brussels Domestic", 580)],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )
        said = by_location(rows)["Brussels Domestic"]["rationale"]

        assert "580" in said
        assert "575" in said

    def test_a_model_figure_that_agrees_with_the_rule_raises_nothing(self):
        rows = apply_rules(
            [row("Belgium - Antwerp Domestic", 570), row("Brussels Domestic", 575)],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )
        brussels = by_location(rows)["Brussels Domestic"]

        assert brussels["suggested_price"] == 575
        assert brussels["flag"] is None

    def test_a_location_with_no_rule_keeps_the_model_s_figure(self):
        rows = apply_rules([row("Taiwan FOB", 825)], [])

        assert by_location(rows)["Taiwan FOB"]["suggested_price"] == 825

    def test_a_switched_off_rule_does_not_override_anything(self):
        rows = apply_rules(
            [row("Belgium - Antwerp Domestic", 570), row("Brussels Domestic", 580)],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR, enabled=False)],
        )

        assert by_location(rows)["Brussels Domestic"]["suggested_price"] == 580

    def test_a_rule_whose_reference_has_no_figure_leaves_the_model_s_alone(self):
        rows = apply_rules(
            [
                row("Belgium - Antwerp Domestic", None, status="no_evidence"),
                row("Brussels Domestic", 580),
            ],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )

        assert by_location(rows)["Brussels Domestic"]["suggested_price"] == 580

    def test_it_still_fills_a_location_the_model_left_empty(self):
        rows = apply_rules(
            [
                row("Belgium - Antwerp Domestic", 570),
                row("Brussels Domestic", None, status="no_evidence"),
            ],
            [rule("Brussels Domestic", "Belgium - Antwerp Domestic", 5, EUR)],
        )
        brussels = by_location(rows)["Brussels Domestic"]

        assert brussels["suggested_price"] == 575
        assert brussels["status"] == "derived"
        assert brussels["flag"] is None


class TestAFigureMustComeFromItsOwnLocationsLines:
    def evidence(self):
        return [
            {"name": "Japan", "price": None, "price_min": 759, "price_max": 791, "currency": "USD"},
            {"name": "Singapore", "price": None, "price_min": 832, "price_max": 842, "currency": "USD"},
            # Real numbers in that issue, from the Vietnam/Malaysia commentary.
            {"name": "Singapore cargoes south Vietnam", "price": 840, "price_min": 830,
             "price_max": 850, "currency": "USD"},
        ]

    def test_japan_priced_at_a_figure_from_another_location_is_not_supported(self):
        rows = [row("Japan FOB", 840, suggested_min=840, suggested_max=840)]

        assert "Japan FOB" in unsupported_by_evidence(rows, self.evidence())

    def test_japan_priced_from_its_own_line_is_supported(self):
        rows = [row("Japan FOB", 775, suggested_min=759, suggested_max=791)]

        assert unsupported_by_evidence(rows, self.evidence()) == set()

    def test_singapore_priced_from_its_own_line_is_supported(self):
        rows = [row("Singapore Bulk FOB", 837, suggested_min=832, suggested_max=842)]

        assert unsupported_by_evidence(rows, self.evidence()) == set()

    def test_a_location_no_report_line_resembles_falls_back_to_the_whole_pool(self):
        # Nothing here is named like Bahrain, so there is no per-location
        # evidence to narrow to. Behaviour stays as it was rather than
        # flagging every such row.
        rows = [row("Bahrain FOB", 832, suggested_min=832, suggested_max=842)]

        assert unsupported_by_evidence(rows, self.evidence()) == set()

    def test_an_invented_figure_is_still_caught_everywhere(self):
        rows = [row("Bahrain FOB", 1234, suggested_min=1234, suggested_max=1234)]

        assert "Bahrain FOB" in unsupported_by_evidence(rows, self.evidence())
