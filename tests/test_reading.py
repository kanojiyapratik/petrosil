"""What one report is asked, and how its answer is read.

Step one reads a single report in its own words: the name as the report
writes it, the figure as printed, the currency and unit as printed. Nothing
here matches a site location, converts a currency or computes a midpoint --
that is step two's work, where every report is present at once.
"""

import json

from app.editorial.reading import parse_reading, reading_prompt


class TestWhatOneReportIsAsked:
    def test_the_report_text_is_in_the_prompt(self):
        prompt = reading_prompt("FOB Asia SN 150 1,260-1,300", "lube-report.docx")

        assert "FOB Asia SN 150 1,260-1,300" in prompt

    def test_the_prompt_names_the_file_so_the_answer_can_be_traced(self):
        assert "lube-report.docx" in reading_prompt("text", "lube-report.docx")

    def test_no_site_location_is_ever_offered_to_the_model(self):
        # The whole point of step one: one report, its own words, nothing to
        # match against. A list of locations here would invite the model to
        # guess a mapping from a single report.
        prompt = reading_prompt("text", "a.docx")

        assert "Singapore SN 150 FOB Group I" not in prompt
        assert "locations" not in prompt.lower()

    def test_the_editors_instructions_ride_along_as_guidance_only(self):
        prompt = reading_prompt("text", "a.docx", "The USA prices are in the picture")

        assert "The USA prices are in the picture" in prompt
        assert "cannot change" in prompt

    def test_the_model_is_told_to_keep_the_figure_exactly_as_printed(self):
        prompt = reading_prompt("text", "a.docx")

        assert "exactly as printed" in prompt
        assert "do not convert" in prompt.lower()


class TestReadingTheAnswer:
    def test_a_plain_answer_becomes_rows(self):
        answer = json.dumps(
            [
                {
                    "name": "Base Oil SN500 EX Kandla",
                    "price": 1560,
                    "currency": "USD",
                    "unit": "MT",
                    "basis": "FOB",
                    "price_date": "2026-08-14",
                }
            ]
        )

        rows = parse_reading(answer)

        assert rows[0]["name"] == "Base Oil SN500 EX Kandla"
        assert rows[0]["price"] == 1560.0
        assert rows[0]["currency"] == "USD"

    def test_a_range_keeps_both_ends_and_the_midpoint_is_not_computed(self):
        # Arithmetic on a price is the server's job in step two, never here.
        rows = parse_reading(
            json.dumps([{"name": "FOB Asia SN 150", "price_min": 1260, "price_max": 1300}])
        )

        assert (rows[0]["price_min"], rows[0]["price_max"]) == (1260.0, 1300.0)
        assert rows[0]["price"] == 1260.0

    def test_a_fenced_answer_is_still_read(self):
        # Models fence JSON however firmly they are told not to.
        rows = parse_reading('```json\n[{"name": "A", "price": 10}]\n```')

        assert len(rows) == 1

    def test_a_row_with_no_name_is_dropped(self):
        rows = parse_reading(json.dumps([{"price": 900}, {"name": "A", "price": 10}]))

        assert [row["name"] for row in rows] == ["A"]

    def test_a_row_with_no_usable_figure_is_dropped(self):
        rows = parse_reading(
            json.dumps([{"name": "A", "price": "n/a"}, {"name": "B", "price": 10}])
        )

        assert [row["name"] for row in rows] == ["B"]

    def test_a_zero_or_negative_figure_is_not_a_price(self):
        rows = parse_reading(json.dumps([{"name": "A", "price": 0}, {"name": "B", "price": -5}]))

        assert rows == []

    def test_a_garbled_answer_reads_as_nothing_rather_than_raising(self):
        # A silent model and a garbled one are the same outcome on screen.
        assert parse_reading("I could not find any prices.") == []
        assert parse_reading(None) == []

    def test_a_currency_is_kept_as_the_report_printed_it(self):
        rows = parse_reading(json.dumps([{"name": "Izmir", "price": 81212, "currency": "try"}]))

        assert rows[0]["currency"] == "TRY"

    def test_a_date_that_is_not_a_date_is_dropped_not_guessed(self):
        rows = parse_reading(
            json.dumps([{"name": "A", "price": 10, "price_date": "week ending Friday"}])
        )

        assert rows[0]["price_date"] is None

    def test_a_shape_valid_day_that_does_not_exist_is_dropped_too(self):
        # "2025-02-30" matched the old YYYY-MM-DD pattern and travelled into
        # the insert, where the DATE column raised -- 500ing the whole
        # reading after every AI call in the batch had been paid for. The
        # row keeps its price; only the impossible date goes.
        rows = parse_reading(
            json.dumps(
                [
                    {"name": "A", "price": 10, "price_date": "2025-02-30"},
                    {"name": "B", "price": 20, "price_date": "2026-13-01"},
                ]
            )
        )

        assert [row["price_date"] for row in rows] == [None, None]
        assert [row["price"] for row in rows] == [10.0, 20.0]

    def test_a_real_day_is_kept(self):
        rows = parse_reading(
            json.dumps([{"name": "A", "price": 10, "price_date": "2026-02-28"}])
        )

        assert rows[0]["price_date"] == "2026-02-28"
