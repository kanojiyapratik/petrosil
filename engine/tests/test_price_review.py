"""The price-review core, ported case-for-case from the TypeScript tests.

Every case here existed in the vitest suite, which itself came from the
Laravel module's PHPUnit suite. Keeping the cases identical is what makes the
port provable rather than hopeful: `/api/price-reviews` is live and called by
baseoil, so behaviour has to be the same to the field.
"""

import math

import pytest

from app.price_review.differ import CurrentPrice, ProposedRow, diff_prices, to_price
from app.price_review.summariser import (
    OUTLIER_ABS_PCT_THRESHOLD,
    OUTLIER_STDDEV_MULTIPLE,
    summarise,
)

TODAY = "2026-08-13"


def diff(price_date="2026-08-20", rows=(), current=(), live=(), today=TODAY):
    return diff_prices(
        price_date=price_date,
        rows=[ProposedRow(location=name, price=price) for name, price in rows],
        current_prices=[CurrentPrice(location=name, price=price) for name, price in current],
        valid_locations=live,
        today=today,
    )


class TestDiffPrices:
    def test_a_location_with_no_price_on_that_date_is_new(self):
        rows = diff(rows=[("Singapore", 845)], live=["Singapore"])

        assert len(rows) == 1
        assert rows[0].location == "Singapore"
        assert rows[0].status == "new"
        assert rows[0].old_price is None
        assert rows[0].new_price == 845

    def test_a_price_equal_to_the_one_held_is_unchanged(self):
        rows = diff(
            rows=[("Singapore", 812)],
            current=[("Singapore", 812)],
            live=["Singapore"],
        )

        assert rows[0].status == "unchanged"
        assert rows[0].old_price == 812

    def test_a_different_price_on_a_future_date_is_changed(self):
        rows = diff(
            rows=[("Singapore", 845)],
            current=[("Singapore", 812)],
            live=["Singapore"],
        )

        assert rows[0].status == "changed"

    def test_a_different_price_on_a_past_date_is_locked(self):
        # Published history is immutable.
        rows = diff(
            price_date="2026-08-01",
            rows=[("Singapore", 845)],
            current=[("Singapore", 812)],
            live=["Singapore"],
        )

        assert rows[0].status == "locked"

    def test_an_empty_past_date_can_still_be_backfilled(self):
        # Prices are entered days after the date they apply to, so a blanket
        # past-date ban would make the module useless.
        rows = diff(price_date="2026-08-01", rows=[("Singapore", 845)], live=["Singapore"])

        assert rows[0].status == "new"

    def test_a_location_the_site_did_not_list_is_unmatched(self):
        rows = diff(rows=[("Atlantis", 845)], live=["Singapore"])

        assert rows[0].status == "unmatched"

    def test_a_negative_price_is_invalid_not_clamped(self):
        rows = diff(rows=[("Singapore", -5)], live=["Singapore"])

        assert rows[0].status == "invalid"

    def test_an_unreadable_price_is_invalid(self):
        for value in ("", "   ", None, "n/a", {}, []):
            rows = diff(rows=[("Singapore", value)], live=["Singapore"])

            assert rows[0].status == "invalid", value

    def test_a_boolean_is_not_a_price(self):
        # bool is a subclass of int in Python; True would otherwise be 1.0.
        rows = diff(rows=[("Singapore", True)], live=["Singapore"])

        assert rows[0].status == "invalid"

    def test_a_numeric_string_is_a_price(self):
        rows = diff(rows=[("Singapore", " 845.5 ")], live=["Singapore"])

        assert rows[0].status == "new"
        assert rows[0].new_price == 845.5

    def test_prices_are_compared_with_a_tolerance(self):
        rows = diff(
            rows=[("Singapore", 0.1 + 0.2)],
            current=[("Singapore", 0.3)],
            live=["Singapore"],
        )

        assert rows[0].status == "unchanged"

    def test_every_row_comes_back_in_order(self):
        rows = diff(
            rows=[("Singapore", 845), ("Atlantis", 1), ("Mumbai", 600)],
            live=["Singapore", "Mumbai"],
        )

        assert [row.location for row in rows] == ["Singapore", "Atlantis", "Mumbai"]
        assert [row.status for row in rows] == ["new", "unmatched", "new"]


class TestToPrice:
    def test_accepts_numbers_and_numeric_strings(self):
        assert to_price(845) == 845.0
        assert to_price(845.5) == 845.5
        assert to_price("845.5") == 845.5

    def test_rejects_blanks_rather_than_reading_them_as_zero(self):
        assert to_price("") is None
        assert to_price("  ") is None
        assert to_price(None) is None

    def test_rejects_nan_and_infinity(self):
        assert to_price(float("nan")) is None
        assert to_price(float("inf")) is None


def diffed(*rows):
    """(location, old, new, status) tuples, as the differ would have produced."""
    from app.price_review.differ import DiffedRow

    return [
        DiffedRow(location=location, old_price=old, new_price=new, status=status)
        for location, old, new, status in rows
    ]


class TestSummarise:
    def test_counts_every_status(self):
        summary = summarise(
            diffed(
                ("A", None, 10, "new"),
                ("B", 10, 12, "changed"),
                ("C", 10, 10, "unchanged"),
                ("D", 10, 12, "changed"),
            ),
            "2026-08-20",
        )

        assert summary.total_rows == 4
        assert summary.by_status == {"changed": 2, "new": 1, "unchanged": 1}
        assert summary.price_date == "2026-08-20"

    def test_counts_rises_and_falls(self):
        summary = summarise(
            diffed(("A", 100, 110, "changed"), ("B", 100, 90, "changed")),
            "2026-08-20",
        )

        assert summary.changes.rose == 1
        assert summary.changes.fell == 1

    def test_reports_the_largest_move_each_way(self):
        summary = summarise(
            diffed(
                ("A", 100, 110, "changed"),
                ("B", 100, 130, "changed"),
                ("C", 100, 95, "changed"),
                ("D", 100, 80, "changed"),
            ),
            "2026-08-20",
        )

        assert summary.changes.largest_rise.location == "B"
        assert summary.changes.largest_rise.change_pct == 30
        assert summary.changes.largest_fall.location == "D"
        assert summary.changes.largest_fall.change_pct == -20

    def test_a_new_row_has_nothing_to_have_moved_from(self):
        summary = summarise(diffed(("A", None, 100, "new")), "2026-08-20")

        assert summary.changes.rose == 0
        assert summary.changes.median_change_pct is None
        assert summary.changes.largest_rise is None

    def test_an_old_price_of_zero_does_not_produce_an_infinite_move(self):
        summary = summarise(diffed(("A", 0, 100, "changed")), "2026-08-20")

        assert summary.changes.median_change_pct is None

    def test_the_median_of_an_even_number_of_moves_is_the_midpoint(self):
        summary = summarise(
            diffed(
                ("A", 100, 110, "changed"),
                ("B", 100, 120, "changed"),
                ("C", 100, 130, "changed"),
                ("D", 100, 140, "changed"),
            ),
            "2026-08-20",
        )

        assert summary.changes.median_change_pct == 25

    def test_a_lone_wild_jump_in_a_flat_batch_is_suspected(self):
        # The absolute floor exists for exactly this: the standard deviation
        # of a flat batch is near zero, so a multiple of it is a meaningless
        # bar.
        rows = diffed(*[("L%d" % i, 100, 101, "changed") for i in range(10)])
        rows.append(
            __import__("app.price_review.differ", fromlist=["DiffedRow"]).DiffedRow(
                location="Typo", old_price=100, new_price=900, status="changed"
            )
        )

        summary = summarise(rows, "2026-08-20")

        assert [error.location for error in summary.suspected_errors] == ["Typo"]
        assert "unusually large move" in summary.suspected_errors[0].reason

    def test_a_ten_percent_move_stands_out_when_everything_else_moved_one(self):
        # The relative half of the rule: 10% is nowhere near the absolute
        # threshold, but it is far from this batch's own mean.
        rows = diffed(*[("L%d" % i, 100, 101, "changed") for i in range(20)])
        rows[0] = __import__("app.price_review.differ", fromlist=["DiffedRow"]).DiffedRow(
            location="Odd", old_price=100, new_price=110, status="changed"
        )

        summary = summarise(rows, "2026-08-20")

        assert "Odd" in [error.location for error in summary.suspected_errors]

    def test_a_zero_price_is_always_suspected(self):
        summary = summarise(diffed(("A", 59.10, 0, "changed")), "2026-08-20")

        assert len(summary.suspected_errors) == 1
        assert "zero" in summary.suspected_errors[0].reason

    def test_a_row_can_collect_more_than_one_reason(self):
        # 59.10 -> 0 is both a -100% move and a zero.
        summary = summarise(diffed(("A", 59.10, 0, "changed")), "2026-08-20")
        reason = summary.suspected_errors[0].reason

        assert "unusually large move" in reason
        assert "zero" in reason

    def test_an_invalid_row_says_so(self):
        summary = summarise(diffed(("A", None, float("nan"), "invalid")), "2026-08-20")

        assert "rejected as invalid" in summary.suspected_errors[0].reason

    def test_an_unremarkable_batch_suspects_nothing(self):
        summary = summarise(
            diffed(("A", 100, 101, "changed"), ("B", 100, 102, "changed")),
            "2026-08-20",
        )

        assert summary.suspected_errors == []

    def test_the_thresholds_are_the_ones_that_were_agreed(self):
        assert OUTLIER_ABS_PCT_THRESHOLD == 50
        assert OUTLIER_STDDEV_MULTIPLE == 3


def test_a_nan_price_never_reaches_the_movement_figures():
    summary = summarise(diffed(("A", 100, float("nan"), "invalid")), "2026-08-20")

    assert summary.changes.rose == 0
    assert summary.changes.median_change_pct is None
