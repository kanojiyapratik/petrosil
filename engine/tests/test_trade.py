"""Trade feeds: the government-statistics parsers and the pass.

Every expected figure here is one the team entered by hand and the live
sources were checked against on 2026-11-13: Thailand's base oil from
Singapore in April 2026 (31,106,885 litres → 31,107), Japan's bitumen from
Korea (27,192 MT → 27,192), Singapore's base oil to China (45,805 t).
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from scraper import trade
from scraper.trade import base, india, japan, singapore, thailand
from scraper.trade.base import Figure, MonthResult, NoData, SourceError


# --------------------------------------------------------------- units

def test_litres_and_kilograms_are_divided_by_a_thousand_and_rounded_half_up():
    assert base.sheet_quantity(Decimal("31106885"), "LTR") == 31107
    assert base.sheet_quantity(Decimal("41565"), "LTR") == 42
    assert base.sheet_quantity(Decimal("43082"), "KGS") == 43


def test_tonnes_and_kilolitres_are_kept_as_written():
    assert base.sheet_quantity(Decimal("27192"), "MT") == 27192
    assert base.sheet_quantity(Decimal("1350"), "KL") == 1350


def test_an_unknown_unit_is_refused_rather_than_guessed():
    with pytest.raises(SourceError):
        base.sheet_quantity(Decimal("5"), "BBL")


def test_numbers_lose_commas_and_revision_marks():
    assert base.parse_number("1,234,567.00") == Decimal("1234567.00")
    assert base.parse_number("24,037,681 (R)") == Decimal("24037681")
    assert base.parse_number("-") is None


# ------------------------------------------------------------- parsers

THAI_PAGE = """
<select><option>SG - SINGAPORE</option></select>
<tr><th width='100px'> Statistic code : 000</th><td>Lubricating oil feedstock (LTR)</td></tr>
<script>var units = "KGM MT";</script>
<h3>HS-CODE 27101941000</h3>
<table>
<tr><th>Code</th><th>Country</th><th>Quantity</th><th>CIF</th></tr>
<tr><td>
 SG </td><td>SINGAPORE</td><td>31,106,885</td><td>953,354,382</td><td>78,548,672</td></tr>
<tr><td>KR</td><td>KOREA,REPUBLIC OF</td><td>8,614,275</td><td>298,021,844</td></tr>
<tr><td>ID</td><td>INDONESIA</td><td>41,565</td><td>935,897</td></tr>
<tr><td>SUM</td><td></td><td>45,330,588</td></tr>
</table>
"""


def test_thailand_reads_the_month_column_and_the_iso_code():
    figures = thailand.parse(THAI_PAGE, "LTR")

    assert [(f.iso2, f.quantity) for f in figures] == [
        ("SG", Decimal("31106885")),
        ("KR", Decimal("8614275")),
        ("ID", Decimal("41565")),
    ]
    assert thailand.unit_of(THAI_PAGE) == "LTR"


def test_thailand_without_its_table_is_a_source_error():
    with pytest.raises(SourceError):
        thailand.parse("<html>maintenance</html>", "LTR")


def test_singapore_keeps_countries_of_the_asked_trade_type_and_drops_regions():
    rows = [
        {"hs8Products": "27101941 - LUBRICATING OIL FEEDSTOCK (TNE)", "market": "WORLD", "tradeType": "EXPORTS", "quantity": "192051"},
        {"hs8Products": "27101941 - LUBRICATING OIL FEEDSTOCK (TNE)", "market": "EAST ASIA + TAIWAN", "tradeType": "EXPORTS", "quantity": "55460"},
        {"hs8Products": "27101941 - LUBRICATING OIL FEEDSTOCK (TNE)", "market": "MAINLAND CHINA", "tradeType": "EXPORTS", "quantity": "45805"},
        {"hs8Products": "27101941 - LUBRICATING OIL FEEDSTOCK (TNE)", "market": "MAINLAND CHINA", "tradeType": "DOMESTIC EXPORTS", "quantity": "40000"},
        {"hs8Products": "27101946 - OTHER LUBRICATING OILS (TNE)", "market": "INDIA", "tradeType": "EXPORTS", "quantity": "815"},
        {"hs8Products": "27101941 - LUBRICATING OIL FEEDSTOCK (TNE)", "market": "INDIA", "tradeType": "IMPORTS", "quantity": "10"},
    ]

    figures = singapore.parse(rows, "27101941", "export")

    assert [(f.partner, f.quantity, f.unit) for f in figures] == [("China", Decimal("45805"), "TNE")]


JAPAN_CSV = (
    "Exp or Imp,Year,HS,Country,Unit1,Unit2,Quantity1-Year,Quantity2-Year,Value-Year,"
    + ",".join(f"Quantity1-{m},Quantity2-{m},Value-{m}" for m in japan.MONTHS)
    + "\n"
    + "2,2026,'271320000',103,  ,MT,0,226241,21706811,0,25970,1684047,0,0,0,0,31566,2087092,0,27192,2884948"
    + ",0" * 24 + "\n"
    + "2,2026,'271019196',112,KL,KG,0,0,0,0,0,0,0,0,0,0,0,0,1350,1218122,418215" + ",0" * 24 + "\n"
)


def test_japan_reads_the_month_from_the_year_to_date_file():
    figures = japan.parse(JAPAN_CSV, "271320", 4)

    assert [(f.partner, f.quantity, f.unit) for f in figures] == [("Republic of Korea", Decimal("27192"), "MT")]


def test_japan_prefers_the_first_unit_when_a_line_has_two():
    figures = japan.parse(JAPAN_CSV, "271019", 4)

    assert [(f.partner, f.quantity, f.unit) for f in figures] == [("Singapore", Decimal("1350"), "KL")]


def test_japan_picks_the_file_whose_chapter_range_holds_the_code():
    listing = (
        "2026年9月分 品別国別表 ４部 16-24類 <a href='/x?statInfId=000040519246&fileKind=1'>CSV</a>"
        "2026年9月分 品別国別表 ５部 ２５-２７類 <a href='/x?statInfId=000040519247&fileKind=1'>CSV</a>"
    )

    assert japan.pick_file(listing, 27) == "000040519247"
    assert japan.pick_file(listing, 20) == "000040519246"
    assert japan.pick_file(listing, 29) is None


INDIA_PAGE = """
<p>Commodity:&nbsp;27101971&nbsp;BASE OIL&nbsp;Unit:&nbsp;KGS</p>
<table>
<tr><th>S.No.</th><th>Country</th><th>Aug-2025 (R)</th><th>Aug-2026 (F)</th><th>%Growth</th></tr>
<tr><td>31</td><td>SINGAPORE</td><td>24,037,681</td><td>25,598,268</td><td>6</td></tr>
<tr><td>2</td><td>U ARAB EMTS</td><td>811,495</td><td>-</td><td></td></tr>
<tr><td></td><td>Total</td><td>227,427,902.00</td><td>139,120,024.00</td></tr>
</table>
"""


def test_india_reads_this_years_month_and_skips_blank_and_total_rows():
    figures, unit = india.parse(INDIA_PAGE)

    assert unit == "KGS"
    assert [(f.partner, f.quantity) for f in figures] == [("Singapore", Decimal("25598268"))]


# --------------------------------------------------------- fetch_month

def _stub(monkeypatch, answers):
    calls = []

    def fake(session, **kwargs):
        calls.append(kwargs)
        answer = answers[kwargs["code"]]

        if isinstance(answer, Exception):
            raise answer

        return answer

    monkeypatch.setitem(trade.SOURCES, "thailand", fake)

    return calls


def test_codes_are_summed_per_partner_before_rounding(monkeypatch):
    _stub(monkeypatch, {
        "A": MonthResult([Figure("Singapore", Decimal("400"), "LTR", "SG")], "u1"),
        "B": MonthResult([Figure("Singapore", Decimal("200"), "LTR", "SG"), Figure("Qatar", Decimal("300"), "LTR", "QA")], "u2"),
    })

    found = trade.fetch_month("thailand", ["A", "B"], 2026, 4, "import")

    # 0.4 + 0.2 = 0.6 → 1; rounding each first would give 0 + 0.
    assert found["partners"] == [{"partner": "Singapore", "iso2": "SG", "qty": "1"}]
    assert found["unit"] == "LTR"
    assert found["source_url"] == "u1"


def test_a_code_with_nothing_is_skipped_but_all_empty_is_no_data(monkeypatch):
    _stub(monkeypatch, {"A": NoData("none"), "B": MonthResult([Figure("Qatar", Decimal("4184867"), "LTR", "QA")])})

    assert trade.fetch_month("thailand", ["A", "B"], 2026, 4, "import")["partners"] == [
        {"partner": "Qatar", "iso2": "QA", "qty": "4185"}
    ]

    _stub(monkeypatch, {"A": NoData("none")})

    with pytest.raises(NoData):
        trade.fetch_month("thailand", ["A"], 2026, 4, "import")


def test_an_unknown_source_is_a_source_error():
    with pytest.raises(SourceError):
        trade.fetch_month("atlantis", ["1"], 2026, 4, "import")


# ------------------------------------------------------------ the pass

class FakeClient:
    def __init__(self, feeds):
        self.feeds = feeds
        self.reported = None

    def trade_feeds(self):
        return {"feeds": self.feeds}

    def report_trade(self, results):
        self.reported = results
        return [{"status": "staged"} for _ in results]


def test_a_feed_stops_at_its_first_unpublished_month(monkeypatch):
    def fake(session, **kwargs):
        if kwargs["month"] == 5:
            return MonthResult([Figure("Singapore", Decimal("2000"), "LTR", "SG")])
        raise NoData("not yet")

    monkeypatch.setitem(trade.SOURCES, "thailand", fake)
    client = FakeClient([{"id": 7, "source": "thailand", "kind": "import", "hs_codes": ["27101941000"],
                          "months": ["2026-05", "2026-06", "2026-07"]}])

    trade.run_trade_pass(client, pause=0)

    assert [(r["month"], r["status"]) for r in client.reported] == [("2026-05", "read"), ("2026-06", "no_data")]
    assert client.reported[0]["partners"] == [{"partner": "Singapore", "iso2": "SG", "qty": "2"}]


def test_a_failing_source_is_reported_and_the_next_feed_still_runs(monkeypatch):
    def broken(session, **kwargs):
        raise SourceError("down")

    def fine(session, **kwargs):
        return MonthResult([Figure("Japan", Decimal("5"), "MT")])

    monkeypatch.setitem(trade.SOURCES, "thailand", broken)
    monkeypatch.setitem(trade.SOURCES, "japan", fine)
    client = FakeClient([
        {"id": 1, "source": "thailand", "kind": "import", "hs_codes": ["1"], "months": ["2026-05"]},
        {"id": 2, "source": "japan", "kind": "export", "hs_codes": ["2"], "months": ["2026-05"]},
    ])

    trade.run_trade_pass(client, pause=0)

    assert [(r["feed_id"], r["status"]) for r in client.reported] == [(1, "failed"), (2, "read")]
    assert client.reported[0]["error"] == "down"


def test_nothing_to_fetch_reports_nothing():
    client = FakeClient([{"id": 1, "source": "thailand", "kind": "import", "hs_codes": ["1"], "months": []}])

    assert trade.run_trade_pass(client, pause=0) == []
    assert client.reported is None
