"""A price far off the scale of its location is not offered at all.

Client's 30-Sep comparison: Vietnam CFR FOB was drafted at 13 on five runs
out of five, against bitumen prices of $300-900 a tonne.
"""

from app.editorial.review import reject_out_of_scale

VIETNAM = "Vietnam CFR FOB"
CHINA = "China East CFR"
KOREA = "South Korea FOB"
TAIWAN = "Taiwan FOB"
BRUSSELS = "Brussels Domestic"
BPCL = "BPCL BITUMEN - VG 10 (bulk)"

SITE = {CHINA: 775, KOREA: 660, TAIWAN: 655, BRUSSELS: 520, BPCL: 71810}
HOME = {BRUSSELS: "EUR", BPCL: "INR"}


def row(location, price, status="suggested", **extra):
    return {
        "location": location,
        "status": status,
        "suggested_min": price,
        "suggested_max": price,
        "suggested_price": price,
        "flag": None,
        "rationale": "From the report.",
        **extra,
    }


def test_a_tiny_figure_for_a_location_with_no_price_yet_is_not_offered():
    [result] = reject_out_of_scale([row(VIETNAM, 13)], SITE, HOME)

    assert result["status"] == "invalid"
    assert result["suggested_price"] is None
    assert "13 is far out of line" in result["rationale"]
    assert "about 660" in result["rationale"]


def test_a_normal_price_for_a_location_with_no_price_yet_is_kept():
    [result] = reject_out_of_scale([row(VIETNAM, 640)], SITE, HOME)

    assert result["status"] == "suggested"
    assert result["suggested_price"] == 640


def test_a_location_is_measured_against_its_own_price_first():
    [result] = reject_out_of_scale([row(KOREA, 100)], SITE, HOME)

    assert result["status"] == "invalid"
    assert "current price of 660" in result["rationale"]


def test_a_huge_figure_is_rejected_too():
    [result] = reject_out_of_scale([row(TAIWAN, 29084)], SITE, HOME)

    assert result["status"] == "invalid"


def test_other_currencies_are_compared_with_their_own_kind():
    # A rupee price is not measured against dollar prices.
    rows = reject_out_of_scale(
        [row(BPCL, 69100), row(BRUSSELS, 515)], SITE, HOME
    )

    assert [r["status"] for r in rows] == ["suggested", "suggested"]


def test_too_few_prices_to_judge_leaves_the_row_alone():
    [result] = reject_out_of_scale([row(VIETNAM, 13)], {CHINA: 775}, {})

    assert result["status"] == "suggested"


def test_a_derived_price_is_checked_as_well():
    [result] = reject_out_of_scale([row(VIETNAM, 13, status="derived")], SITE, HOME)

    assert result["status"] == "invalid"


def test_rows_without_a_price_are_untouched():
    empty = {"location": VIETNAM, "status": "no_evidence", "suggested_price": None}

    assert reject_out_of_scale([dict(empty)], SITE, HOME) == [empty]
