"""Foreign-currency report figures, converted by code before the rules run.

The client's Russia rule (2026-08-27): Turkey prices are printed in lira
(excluding VAT); convert to USD at the rate for the SAME date, then Russia
Domestic is 10% under that. No rate for that date -> do not touch Russia,
flag for manual review. The conversion and its rate are recorded so the
audit line can cite them.
"""

import json

import pytest
import requests

from app.editorial.fx import MAX_RATE_AGE_DAYS, FrankfurterRates, FxRate, convert_rows
from app.editorial.review import build_rows, editorial_prompt, parse_suggestions
from app.editorial.rules import PriceRule, apply_rules

TURKEY = "Report: Turkey SN150 (TRY/MT ex VAT)"
RUSSIA = "Russia Domestic SN 150 Group I"
RUSSIA_FOB = "Russia FOB SN 150 Group I"
LOCATIONS = [RUSSIA, RUSSIA_FOB, TURKEY]


def turkey_row(**overrides):
    row = {
        "location": TURKEY,
        "suggested_min": 81212,
        "suggested_max": 81212,
        "currency": "TRY",
        "price_date": "2026-08-19",
        "confidence": "high",
        "basis": "ex rack Izmir, excluding VAT (VAT TRY 18,271.70/t)",
        "source": "Lube Report, Turkey section",
        "rationale": "Tupras last posted price.",
    }
    row.update(overrides)

    return row


def draft(model_rows, current=None):
    parsed = parse_suggestions(json.dumps(model_rows), LOCATIONS)

    return build_rows(LOCATIONS, current or {}, parsed)


class FakeRates:
    def __init__(self, table):
        self.table = table
        self.asked = []

    def get(self, currency, on_date):
        self.asked.append((currency, on_date))

        return self.table.get((currency, on_date))


RATE = FxRate(currency="TRY", rate=40.921, rate_date="2026-08-19", source="ECB")


def row_for(rows, location):
    return next(r for r in rows if r["location"] == location)


class TestPrompt:
    def test_asks_for_figures_as_printed_with_their_currency(self):
        prompt = editorial_prompt([TURKEY], ["report"])

        assert '"currency"' in prompt
        assert '"price_date"' in prompt
        assert "VAT" in prompt


class TestBuildRows:
    def test_a_lira_figure_is_kept_as_printed_and_marked_foreign(self):
        row = row_for(draft([turkey_row()]), TURKEY)

        assert row["status"] == "foreign"
        assert row["currency"] == "TRY"
        assert row["price_date"] == "2026-08-19"
        assert row["suggested_price"] == 81212

    def test_usd_rows_carry_no_currency(self):
        row = row_for(draft([turkey_row(currency="usd")]), TURKEY)

        assert row["status"] == "suggested"
        assert row["currency"] is None

    def test_a_bad_date_is_dropped_not_trusted(self):
        row = row_for(draft([turkey_row(price_date="19/08")]), TURKEY)

        assert row["price_date"] is None


class TestConvertRows:
    def test_divides_by_the_rate_for_the_price_date(self):
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = convert_rows(draft([turkey_row()]), rates, pricedate="2026-08-26")
        row = row_for(rows, TURKEY)

        assert rates.asked == [("TRY", "2026-08-19")]
        assert row["status"] == "suggested"
        assert row["currency"] is None
        assert row["suggested_price"] == 1984.6  # 81212 / 40.921, 2 dp
        assert row["suggested_min"] == 1984.6
        assert "TRY 81,212" in row["conversion"]
        assert "40.9210" in row["conversion"]
        assert "19-08-26" in row["conversion"]
        assert row["rationale"].startswith(row["conversion"])
        assert row["fx_rate"] == 40.921
        assert row["fx_date"] == "2026-08-19"

    def test_uses_the_draft_date_when_the_report_gives_none(self):
        same_day = FxRate(currency="TRY", rate=40.921, rate_date="2026-08-26", source="ECB")
        rates = FakeRates({("TRY", "2026-08-26"): same_day})
        rows = convert_rows(draft([turkey_row(price_date=None)]), rates, pricedate="2026-08-26")

        assert rates.asked == [("TRY", "2026-08-26")]
        assert row_for(rows, TURKEY)["status"] == "suggested"

    def test_no_rate_means_manual_review_not_a_guess(self):
        rows = convert_rows(draft([turkey_row()]), FakeRates({}), pricedate="2026-08-26")
        row = row_for(rows, TURKEY)

        assert row["status"] == "needs_rate"
        assert row["suggested_price"] == 81212  # untouched, still lira
        assert "no TRY" in row["rationale"]
        assert "19-08-26" in row["rationale"]

    def test_a_stale_rate_is_refused(self):
        old = FxRate(currency="TRY", rate=40.0, rate_date="2026-08-10", source="ECB")
        rows = convert_rows(
            draft([turkey_row()]), FakeRates({("TRY", "2026-08-19"): old}), pricedate="2026-08-26"
        )

        assert row_for(rows, TURKEY)["status"] == "needs_rate"

    def test_a_weekend_falls_back_to_the_last_working_day(self):
        # 2026-08-22 is a Saturday; Friday's rate is the applicable one.
        friday = FxRate(currency="TRY", rate=41.0, rate_date="2026-08-21", source="ECB")
        rows = convert_rows(
            draft([turkey_row(price_date="2026-08-22")]),
            FakeRates({("TRY", "2026-08-22"): friday}),
            pricedate="2026-08-26",
        )

        assert MAX_RATE_AGE_DAYS >= 1
        assert row_for(rows, TURKEY)["status"] == "suggested"

    def test_a_rate_after_the_price_date_is_refused(self):
        later = FxRate(currency="TRY", rate=41.0, rate_date="2026-08-20", source="ECB")
        rows = convert_rows(
            draft([turkey_row()]), FakeRates({("TRY", "2026-08-19"): later}), pricedate="2026-08-26"
        )

        assert row_for(rows, TURKEY)["status"] == "needs_rate"

    def test_usd_rows_are_left_alone(self):
        rates = FakeRates({})
        rows = convert_rows(draft([turkey_row(currency=None)]), rates, pricedate="2026-08-26")

        assert rates.asked == []
        assert row_for(rows, TURKEY)["status"] == "suggested"


RULES = [
    PriceRule(id=1, derived_location=RUSSIA, reference_location=TURKEY, adjustment_value=-10.0),
    PriceRule(id=2, derived_location=RUSSIA_FOB, reference_location=RUSSIA, adjustment_value=-10.0),
]


class TestRussiaChain:
    def test_russia_is_ten_percent_under_the_converted_turkey_price(self):
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = apply_rules(convert_rows(draft([turkey_row()]), rates, pricedate="2026-08-26"), RULES)

        # 81212 / 40.921 = 1984.60 -> x0.9 = 1786.14 -> 1786; FOB 1607.4 -> 1607
        assert row_for(rows, RUSSIA)["status"] == "derived"
        assert row_for(rows, RUSSIA)["suggested_price"] == 1786
        assert row_for(rows, RUSSIA_FOB)["suggested_price"] == 1607

    def test_the_russia_audit_line_cites_the_lira_figure_and_the_rate(self):
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = apply_rules(convert_rows(draft([turkey_row()]), rates, pricedate="2026-08-26"), RULES)
        russia = row_for(rows, RUSSIA)

        assert "TRY 81,212" in russia["rationale"]
        assert "40.9210" in russia["rationale"]
        assert "-10%" in russia["rationale"]

    def test_without_a_rate_russia_is_not_touched(self):
        rows = apply_rules(
            convert_rows(draft([turkey_row()]), FakeRates({}), pricedate="2026-08-26"), RULES
        )

        assert row_for(rows, RUSSIA)["status"] == "no_evidence"
        assert row_for(rows, RUSSIA_FOB)["status"] == "no_evidence"

    def test_an_unconverted_foreign_row_never_feeds_a_rule(self):
        # If conversion is skipped, the lira number must not leak into USD arithmetic.
        rows = apply_rules(draft([turkey_row()]), RULES)

        assert row_for(rows, RUSSIA)["status"] == "no_evidence"


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def get(self, url, timeout=None):
        self.calls.append(url)

        if self.error:
            raise self.error

        return self.response


class TestFrankfurterRates:
    def test_reads_units_per_usd_for_the_date(self):
        session = FakeSession(
            FakeResponse(200, {"base": "USD", "date": "2026-08-19", "rates": {"TRY": 40.921}})
        )
        rate = FrankfurterRates(session=session).get("TRY", "2026-08-19")

        assert "2026-08-19" in session.calls[0]
        assert rate == FxRate(currency="TRY", rate=40.921, rate_date="2026-08-19", source="ECB")

    def test_a_failure_is_none_not_a_crash(self):
        def fetch(session):
            return FrankfurterRates(session=session).get("TRY", "2026-08-19")

        assert fetch(FakeSession(error=requests.ConnectionError())) is None
        assert fetch(FakeSession(FakeResponse(404, {}))) is None
        assert fetch(FakeSession(FakeResponse(200, {"rates": {}}))) is None


class FakeFxStore:
    def __init__(self):
        self.saved = {}

    def get(self, currency, on_date):
        return self.saved.get((currency, on_date))

    def put(self, on_date, rate):
        self.saved[(rate.currency, on_date)] = rate


class TestCachedRates:
    def test_fetches_once_then_reads_the_store(self):
        from app.editorial.fx import CachedRates

        fetcher = FakeRates({("TRY", "2026-08-19"): RATE})
        store = FakeFxStore()
        cached = CachedRates(fetcher, store)

        assert cached.get("TRY", "2026-08-19") == RATE
        assert cached.get("TRY", "2026-08-19") == RATE
        assert fetcher.asked == [("TRY", "2026-08-19")]
        assert store.saved[("TRY", "2026-08-19")] == RATE

    def test_a_miss_is_not_cached(self):
        from app.editorial.fx import CachedRates

        fetcher = FakeRates({})
        store = FakeFxStore()

        assert CachedRates(fetcher, store).get("TRY", "2026-08-19") is None
        assert store.saved == {}


class TestHeadlessApi:
    def test_converts_a_lira_benchmark_before_answering(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from app.ai.gemini import AiCompletion
        from app.api import create_api
        from tests.test_editorial import StubDriver, TOKEN, build_docx

        answer = AiCompletion(
            status="complete", text=json.dumps([turkey_row()]),
            prompt_tokens=1, completion_tokens=1, error=None,
        )
        app = FastAPI()
        app.include_router(
            create_api(
                api_token=TOKEN, driver=StubDriver(answer), default_model="m",
                fx=FakeRates({("TRY", "2026-08-19"): RATE}),
            )
        )
        response = TestClient(app).post(
            "/api/editorial-reviews",
            data={"payload": json.dumps({
                "price_date": "2026-08-26",
                "current_prices": [{"location": TURKEY, "price": None}],
            })},
            files=[("documents", ("r.docx", build_docx(["Turkey SN150 Tl 81,212"]),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
            headers={"authorization": f"Bearer {TOKEN}"},
        )

        assert response.status_code == 201
        row = response.json()["rows"][0]
        assert row["status"] == "suggested"
        assert row["suggested_price"] == 1984.6
        assert row["fx_rate"] == 40.921

    def test_a_caller_can_say_a_location_is_priced_in_rupees(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from app.ai.gemini import AiCompletion
        from app.api import create_api
        from tests.test_editorial import StubDriver, TOKEN, build_docx

        answer = AiCompletion(
            status="complete", text=json.dumps([rupee_row()]),
            prompt_tokens=1, completion_tokens=1, error=None,
        )
        app = FastAPI()
        app.include_router(
            create_api(
                api_token=TOKEN, driver=StubDriver(answer), default_model="m",
                fx=FakeRates({}),
            )
        )
        response = TestClient(app).post(
            "/api/editorial-reviews",
            data={"payload": json.dumps({
                "price_date": "2026-09-01",
                "current_prices": [{"location": BPCL, "price": None, "currency": "INR"}],
            })},
            files=[("documents", ("r.docx", build_docx(["BPCL VG10 bulk 69,100"]),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))],
            headers={"authorization": f"Bearer {TOKEN}"},
        )

        assert response.status_code == 201
        row = response.json()["rows"][0]
        assert row["status"] == "suggested"
        assert row["suggested_price"] == 69100


BPCL = "BPCL BITUMEN - VG 10 (bulk)"
TURKEY_EUR = "Turkey Domestic EUR"
HOME_LOCATIONS = [BPCL, TURKEY_EUR, RUSSIA, TURKEY]
EUR_RATE = FxRate(currency="EUR", rate=0.9, rate_date="2026-08-19", source="ECB")


def home_draft(model_rows, current=None):
    parsed = parse_suggestions(json.dumps(model_rows), HOME_LOCATIONS)

    return build_rows(HOME_LOCATIONS, current or {}, parsed)


def rupee_row(**overrides):
    row = {
        "location": BPCL,
        "suggested_min": 69100,
        "suggested_max": 69100,
        "currency": "INR",
        "price_date": "2026-08-19",
        "confidence": "high",
        "basis": "Ex Mumbai Refinery, basic rate",
        "source": "BPCL rate list wef 01.09.2026",
        "rationale": "Printed on the circular.",
    }
    row.update(overrides)

    return row


class TestHomeCurrency:
    """A location is priced in its own currency, and the site says which.

    Bitumart's refinery prices are rupees and its European domestic prices
    are euros. Converting every non-dollar figure to dollars would publish
    a Rs 69,100 circular price as about $780 on a rupee location -- the
    site stores whatever number it is given in that location's currency.
    """

    def test_a_figure_in_its_own_locations_currency_is_kept_as_printed(self):
        rates = FakeRates({})
        rows = convert_rows(
            home_draft([rupee_row()], {BPCL: 67940}), rates, "2026-08-19", home={BPCL: "INR"}
        )
        row = row_for(rows, BPCL)

        assert row["status"] == "suggested"
        assert row["currency"] is None
        assert row["suggested_price"] == 69100
        assert row["change_pct"] == 1.71
        assert "conversion" not in row
        assert rates.asked == []

    def test_the_home_currency_is_compared_regardless_of_case(self):
        rows = convert_rows(
            home_draft([rupee_row()]), FakeRates({}), "2026-08-19", home={BPCL: "inr"}
        )

        assert row_for(rows, BPCL)["suggested_price"] == 69100

    def test_a_foreign_figure_becomes_the_locations_own_currency_not_dollars(self):
        # Lira for a euro location: through the dollar, since the rates are
        # published per dollar, but it lands in euros.
        rates = FakeRates({("TRY", "2026-08-19"): RATE, ("EUR", "2026-08-19"): EUR_RATE})
        rows = convert_rows(
            home_draft([turkey_row(location=TURKEY_EUR)]),
            rates,
            "2026-08-19",
            home={TURKEY_EUR: "EUR"},
        )
        row = row_for(rows, TURKEY_EUR)

        assert row["status"] == "suggested"
        assert row["currency"] is None
        assert row["suggested_price"] == pytest.approx(81212 / 40.921 * 0.9, abs=0.01)
        assert "EUR" in row["conversion"]
        assert "TRY" in row["conversion"]

    def test_no_rate_for_the_locations_own_currency_leaves_the_row_for_a_person(self):
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = convert_rows(
            home_draft([turkey_row(location=TURKEY_EUR)]),
            rates,
            "2026-08-19",
            home={TURKEY_EUR: "EUR"},
        )
        row = row_for(rows, TURKEY_EUR)

        assert row["status"] == "needs_rate"
        assert row["suggested_price"] == 81212
        assert "EUR" in row["rationale"]

    def test_a_dollar_location_still_gets_dollars(self):
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = convert_rows(
            home_draft([turkey_row(location=RUSSIA)]), rates, "2026-08-19", home={RUSSIA: "USD"}
        )

        assert row_for(rows, RUSSIA)["suggested_price"] == 1984.6

    def test_a_report_benchmark_still_becomes_dollars(self):
        # Benchmarks are not site locations and have no home; baseoil's
        # Russia rule depends on the lira benchmark arriving in dollars.
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = convert_rows(home_draft([turkey_row()]), rates, "2026-08-19", home={BPCL: "INR"})

        assert row_for(rows, TURKEY)["suggested_price"] == 1984.6

    def test_without_a_home_map_nothing_changes(self):
        rates = FakeRates({("TRY", "2026-08-19"): RATE})
        rows = convert_rows(home_draft([turkey_row(location=TURKEY_EUR)]), rates, "2026-08-19")

        assert row_for(rows, TURKEY_EUR)["suggested_price"] == 1984.6
