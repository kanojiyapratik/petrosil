"""Derived prices: the client's rulebook, applied by code -- never by the AI.

The owner's ruling (Riaz, 2026-08-25): the model extracts only the source
prices; a stored rule like "South Korea FOB = Singapore FOB - 10%" is plain
arithmetic the server does, labelled as derived, skipped when the source is
missing or uncertain, and auditable afterwards.
"""

from app.editorial.review import build_rows, parse_suggestions
from app.editorial.rules import PriceRule, apply_rules

import json

SINGAPORE = "Singapore SN 150 FOB Group I"
KOREA = "Korea TOBS FOB Group II/ II+"
JAPAN = "Japan SN 150 FOB Group I"

LOCATIONS = [SINGAPORE, KOREA, JAPAN]


def draft(model_rows, current=None):
    parsed = parse_suggestions(json.dumps(model_rows), LOCATIONS)

    return build_rows(LOCATIONS, current or {}, parsed)


def suggestion(location, low, high):
    return {
        "location": location,
        "suggested_min": low,
        "suggested_max": high,
        "confidence": "high",
        "basis": "FOB Asia, 22-Aug-2026",
        "source": "Lube Report",
        "rationale": "Direct assessment.",
    }


RULE = PriceRule(
    id=1, derived_location=KOREA, reference_location=SINGAPORE, adjustment_pct=-10.0
)


class TestApplyRules:
    def test_derives_a_price_from_its_reference(self):
        # The client's own example: Singapore 800 -> South Korea 800 x 0.90.
        rows = apply_rules(draft([suggestion(SINGAPORE, 800, 800)]), [RULE])
        row = next(r for r in rows if r["location"] == KOREA)

        assert row["status"] == "derived"
        assert row["suggested_price"] == 720
        assert row["derived_from"] == SINGAPORE
        assert row["rule_pct"] == -10.0

    def test_the_whole_range_is_scaled_and_rounded_to_whole_dollars(self):
        rows = apply_rules(draft([suggestion(SINGAPORE, 1555, 1595)]), [RULE])
        row = next(r for r in rows if r["location"] == KOREA)

        # 1555 * 0.9 = 1399.5 -> 1400 (nearest whole USD, half away from zero)
        assert row["suggested_min"] == 1400
        assert row["suggested_max"] == 1436
        assert row["suggested_price"] == 1418

    def test_the_calculation_is_written_down_for_the_audit_trail(self):
        rows = apply_rules(draft([suggestion(SINGAPORE, 800, 800)]), [RULE])
        row = next(r for r in rows if r["location"] == KOREA)

        assert "Singapore SN 150 FOB Group I" in row["rationale"]
        assert "-10%" in row["rationale"]
        assert "800" in row["rationale"]

    def test_no_reference_price_means_no_derivation(self):
        # "Do not calculate it if the Singapore price is missing."
        rows = apply_rules(draft([]), [RULE])

        assert next(r for r in rows if r["location"] == KOREA)["status"] == "no_evidence"

    def test_an_uncertain_reference_is_not_derived_from(self):
        # A close-match still awaits a human; arithmetic on top of a guess
        # would launder the uncertainty away.
        rows = apply_rules(draft([suggestion("Singapore Group I SN 150", 800, 800)]), [RULE])

        assert next(r for r in rows if r["location"] == SINGAPORE)["status"] == "near_match"
        assert next(r for r in rows if r["location"] == KOREA)["status"] == "no_evidence"

    def test_a_direct_price_beats_a_derived_one(self):
        rows = apply_rules(
            draft([suggestion(SINGAPORE, 800, 800), suggestion(KOREA, 750, 750)]), [RULE]
        )
        row = next(r for r in rows if r["location"] == KOREA)

        assert row["status"] == "suggested"
        assert row["suggested_price"] == 750

    def test_a_disabled_rule_does_nothing(self):
        disabled = PriceRule(
            id=1, derived_location=KOREA, reference_location=SINGAPORE,
            adjustment_pct=-10.0, enabled=False,
        )
        rows = apply_rules(draft([suggestion(SINGAPORE, 800, 800)]), [disabled])

        assert next(r for r in rows if r["location"] == KOREA)["status"] == "no_evidence"

    def test_change_and_the_check_flag_apply_to_derived_prices_too(self):
        # Kian reviews any unusually large change -- the same flag as always.
        rows = apply_rules(
            draft([suggestion(SINGAPORE, 800, 800)], current={KOREA: 400}), [RULE]
        )
        row = next(r for r in rows if r["location"] == KOREA)

        assert row["change_pct"] == 80.0
        assert row["flag"] == "check"

    def test_a_positive_adjustment_adds(self):
        plus = PriceRule(
            id=2, derived_location=JAPAN, reference_location=SINGAPORE, adjustment_pct=3.0
        )
        rows = apply_rules(draft([suggestion(SINGAPORE, 1000, 1000)]), [plus])

        assert next(r for r in rows if r["location"] == JAPAN)["suggested_price"] == 1030

    def test_a_rule_naming_an_unknown_location_is_ignored(self):
        stray = PriceRule(
            id=3, derived_location="Atlantis SN 150", reference_location=SINGAPORE,
            adjustment_pct=-10.0,
        )
        rows = apply_rules(draft([suggestion(SINGAPORE, 800, 800)]), [stray])

        assert all(r["location"] in LOCATIONS for r in rows)
