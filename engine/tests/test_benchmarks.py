"""The focused benchmark pass.

A whole Lube Report is ~60k characters of news prose with a handful of price
lines inside it, and the benchmarks the rulebook needs are asked for at the
end of a list of 58 names. Measured 2026-09-01 on the 19.08 report: OpenAI
models skim -- gpt-4o returned 8/8, 7/8 and 5/8 benchmarks on three identical
runs, gpt-4o-mini 5-6/8. So the benchmarks get their own, small, second
call: only the price-bearing lines, only the benchmark names, one answer per
name. Code picks the lines; the model only reads.
"""

import json

from app.editorial.benchmarks import benchmark_prompt, merge_benchmarks, price_digest
from app.editorial.review import parse_suggestions

REPORT = """Weekly Asia Base Oil Price Report
Houthi militants' attacks on tankers have pushed producers to build reserves.
Crude oil futures continued upward, with WTI hovering near $85 per barrel.
Buyers were hesitant to accept current prices because it was not clear whether
they would be able to offset the heftier values through lubricant increases.
Some cargoes were heard making their way from India to Brazil.
Base OilsSpot base oil prices in Asia were again mixed this week.
Ex-tank SingaporeGroup ISolvent neutral 150 edged up by $10 to $1,460/t-$1,500/t
FOB AsiaGroup ISN150 edged up by $10/t to $1,270/t-$1,310/t
There have been no updates or news from Izmir. Tupras' last prices ex rack Izmir refinery are shown here:
Group I, ex rack IzmirSN150: Tl 81,212.00/t plus, VAT Tl 18,271.70/t
Traders in Turkey have advised that no resale offers will be available.
Group III base oils appear to have been removed from the Turkish market.
"""

BENCHMARKS = ["Report: FOB Asia SN 150", "Report: Ex-tank Singapore SN 150", "Report: Turkey SN 150"]


class TestPriceDigest:
    def test_keeps_price_lines_and_their_neighbours_only(self):
        digest = price_digest([REPORT])

        assert "$1,270/t-$1,310/t" in digest
        assert "Tl 81,212.00/t" in digest
        # The line before the lira table names the refinery -- context the
        # model needs to know these are Turkish prices.
        assert "Tupras' last prices ex rack Izmir" in digest
        # Prose two lines away from any price is gone: that is the point.
        assert "India to Brazil" not in digest
        assert "Turkish market" not in digest

    def test_a_report_with_no_prices_gives_an_empty_digest(self):
        assert price_digest(["Nothing but words here.\nAnd more words."]) == ""

    def test_reports_are_kept_apart(self):
        digest = price_digest(["Price A $100/t", "Price B $200/t"])

        assert "--- Report 1 ---" in digest
        assert "--- Report 2 ---" in digest


class TestBenchmarkPrompt:
    def test_asks_for_every_benchmark_by_name_and_allows_null(self):
        prompt = benchmark_prompt(BENCHMARKS, "FOB Asia SN150 $1,270/t-$1,310/t", None)

        for name in BENCHMARKS:
            assert name in prompt

        assert "one object for EVERY" in prompt
        assert "null" in prompt
        # The lira rule from the main prompt must hold here too.
        assert "Never convert" in prompt
        assert "TRY" in prompt

    def test_editor_instructions_ride_along_as_guidance(self):
        prompt = benchmark_prompt(BENCHMARKS, "digest", "The Turkey table is ex VAT.")

        assert "The Turkey table is ex VAT." in prompt
        assert "cannot change" in prompt


class TestMerge:
    def suggestion(self, name, low, high):
        return {"location": name, "suggested_min": low, "suggested_max": high,
                "confidence": "high", "basis": "b", "source": "s", "rationale": "r"}

    def test_focused_figures_fill_benchmarks_the_main_pass_missed(self):
        asked = ["Singapore SN 150 FOB Group I"] + BENCHMARKS
        main = parse_suggestions(json.dumps([self.suggestion("Singapore SN 150 FOB Group I", 1, 2)]), asked)
        focused = parse_suggestions(
            json.dumps([self.suggestion("Report: FOB Asia SN 150", 1270, 1310)]), BENCHMARKS
        )

        merged = merge_benchmarks(main, focused, BENCHMARKS)

        assert merged.suggestions["Report: FOB Asia SN 150"]["suggested_min"] == 1270
        assert "Singapore SN 150 FOB Group I" in merged.suggestions

    def test_a_focused_figure_beats_the_main_one_for_a_benchmark(self):
        # The focused pass read a short digest with one job; it is the more
        # careful reading of the two.
        main = parse_suggestions(json.dumps([self.suggestion("Report: Turkey SN 150", 999, 999)]), BENCHMARKS)
        focused = parse_suggestions(json.dumps([self.suggestion("Report: Turkey SN 150", 81212, 81212)]), BENCHMARKS)

        merged = merge_benchmarks(main, focused, BENCHMARKS)

        assert merged.suggestions["Report: Turkey SN 150"]["suggested_min"] == 81212

    def test_a_null_focused_answer_keeps_the_main_figure(self):
        # "One object per benchmark" means nulls come back for the absent
        # ones; a null must never erase a figure the main pass did find.
        main = parse_suggestions(json.dumps([self.suggestion("Report: Turkey SN 150", 81212, 81212)]), BENCHMARKS)
        focused = parse_suggestions(json.dumps([self.suggestion("Report: Turkey SN 150", None, None)]), BENCHMARKS)

        merged = merge_benchmarks(main, focused, BENCHMARKS)

        assert merged.suggestions["Report: Turkey SN 150"]["suggested_min"] == 81212

    def test_focused_rows_for_non_benchmarks_are_ignored(self):
        main = parse_suggestions("[]", BENCHMARKS)
        focused = parse_suggestions(json.dumps([self.suggestion("Report: FOB Asia SN 150", 1, 2)]), BENCHMARKS)

        merged = merge_benchmarks(main, focused, ["Report: Turkey SN 150"])

        assert "Report: FOB Asia SN 150" not in merged.suggestions


class TestReportPrefixTolerance:
    def test_a_benchmark_named_without_its_report_prefix_still_matches(self):
        # gpt-4o-mini answered "Turkey SN 150" for "Report: Turkey SN 150".
        # Same thing; the prefix is our labelling, not the report's.
        parsed = parse_suggestions(
            json.dumps([{"location": "Turkey SN 150", "suggested_min": 81212, "suggested_max": 81212}]),
            BENCHMARKS,
        )

        assert "Report: Turkey SN 150" in parsed.suggestions
        assert parsed.suggestions["Report: Turkey SN 150"]["location"] == "Report: Turkey SN 150"
        assert parsed.unmatched == []
