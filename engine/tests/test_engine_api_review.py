"""Reviewing a staged batch before it is committed -- baseoil's old
"Run analysis", now asked for by the app for any brand
(POST /api/engine/sites/{slug}/batches/{id}/review).

Pinned: the figures are the engine's (the model is handed the summary,
never asked to count), the site's own model is used and its use recorded
against the site, and a model that fails still answers 200 with a review
that says so -- the app stores and shows it, and the editor tries again.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.ai.providers import AiCompletion
from test_engine_api import ACTOR, HEADERS
from test_engine_api_estate import Usage, build

URL = "/api/engine/sites/baseoil/batches/12/review"

BODY = {
    # A date still ahead: a past one is locked, and a locked row is not judged.
    "price_date": (date.today() + timedelta(days=7)).isoformat(),
    "rows": [
        {"location": "Korea TOBS", "price": 1414},
        {"location": "Singapore SN 150", "price": 15150},
        {"location": "UAE SN 500", "price": 650},
    ],
    "current_prices": [
        {"location": "Korea TOBS", "price": 1400},
        {"location": "Singapore SN 150", "price": 1500},
    ],
}


class Reviewer:
    provider_key = "openai"
    model = "gpt-4.1"

    def __init__(self, fail=False):
        self.prompts = []
        self.fail = fail

    def generate(self, prompt):
        self.prompts.append(prompt)

        if self.fail:
            raise RuntimeError("provider down")

        return AiCompletion(status="complete", text="Singapore looks like a slipped digit.", prompt_tokens=50, completion_tokens=20, error=None)


def test_the_engine_counts_and_the_model_narrates():
    usage, driver = Usage(), Reviewer()
    api, store = build(usage=usage, driver=driver)

    response = api.post(URL, headers=HEADERS, json=BODY)

    assert response.status_code == 200
    body = response.json()
    assert body["analysis"] == {"status": "complete", "output_markdown": "Singapore looks like a slipped digit.", "model": "gpt-4.1", "error": None}
    assert body["summary"]["total_rows"] == 3
    assert body["summary"]["changes"]["rose"] == 2
    # A tenfold move is flagged by the engine, not left to the model to notice.
    assert any(error["location"] == "Singapore SN 150" for error in body["summary"]["suspected_errors"])

    # The model is handed the figures, not the rows to count.
    prompt = driver.prompts[0]
    assert "internal reviewer" in prompt and '"total_rows": 3' in prompt
    assert usage.recorded[-1] == {
        "kind": "price_review", "provider": "openai", "model": "gpt-4.1", "status": "complete",
        "prompt_tokens": 50, "completion_tokens": 20, "site_slug": "baseoil",
    }
    assert store.recorded[-1] == (ACTOR, "asked for a batch review", "baseoil", "batch #12: complete")


def test_a_model_that_fails_is_a_review_that_says_so():
    usage = Usage()
    api, _ = build(usage=usage, driver=Reviewer(fail=True))

    response = api.post(URL, headers=HEADERS, json=BODY)

    assert response.status_code == 200
    assert response.json()["analysis"]["status"] == "failed"
    assert "provider down" in response.json()["analysis"]["error"]
    assert response.json()["summary"]["total_rows"] == 3
    assert usage.recorded[-1]["status"] == "failed"


def test_refuses_a_bad_date_no_rows_and_strangers():
    api, _ = build(driver=Reviewer())

    assert api.post(URL, headers=HEADERS, json={**BODY, "price_date": "3 Nov"}).status_code == 422
    empty = api.post(URL, headers=HEADERS, json={**BODY, "rows": [{"location": "X", "price": "12"}]})
    assert empty.status_code == 422
    assert "no rows" in empty.text
    assert api.post(URL, json=BODY).status_code == 401
    assert api.post("/api/engine/sites/nowhere/batches/12/review", headers=HEADERS, json=BODY).status_code == 404


# ---------------------------------------------------------- customs sheets

FIGURES = {"period_month": "2026-02", "totals": {"shipments": 57, "quantity_tonnes": "487648.794"}}


def test_a_customs_sheet_is_narrated_from_the_apps_figures_by_the_sites_model():
    usage, driver = Usage(), Reviewer()
    api, store = build(usage=usage, driver=driver)

    response = api.post(
        "/api/engine/sites/baseoil/trade-analysis", headers=HEADERS,
        json={"title": "Petroleum Coke imports — February 2026", "figures": FIGURES},
    )

    assert response.status_code == 200
    assert response.json()["analysis"]["status"] == "complete"
    prompt = driver.prompts[0]
    assert "commodity trade analyst" in prompt and "487648.794" in prompt and "Petroleum Coke imports" in prompt
    assert usage.recorded[-1]["kind"] == "trade_import" and usage.recorded[-1]["site_slug"] == "baseoil"
    assert store.recorded[-1][1] == "asked for a customs sheet analysis"


def test_a_customs_sheet_needs_a_title_and_figures():
    api, _ = build(driver=Reviewer())

    assert api.post("/api/engine/sites/baseoil/trade-analysis", headers=HEADERS, json={"title": "x"}).status_code == 422
    assert api.post("/api/engine/sites/baseoil/trade-analysis", headers=HEADERS, json={"figures": FIGURES}).status_code == 422
    failed = api.post("/api/engine/sites/baseoil/trade-analysis", headers=HEADERS, json={"title": "x", "figures": FIGURES})
    assert failed.status_code == 200


TRADE_FIGURES = {
    "product": "Lubricating base oil",
    "direction": "imports",
    "month": "April 2026",
    "unit": "thousand litres (kilolitres)",
    "total": 45331,
    "leading_partners": [{"partner": "Singapore", "quantity": 31107, "share_percent": 68.6}],
}


def test_a_trade_insight_is_narrated_by_the_sites_model_from_the_figures_sent():
    usage, driver = Usage(), Reviewer()
    api, store = build(usage=usage, driver=driver)

    response = api.post(
        "/api/engine/sites/baseoil/trade-insight", headers=HEADERS,
        json={"title": "Thailand Lubricating base oil imports — April 2026", "figures": TRADE_FIGURES},
    )

    assert response.status_code == 200
    assert response.json()["analysis"]["status"] == "complete"
    prompt = driver.prompts[0]
    assert "market insight" in prompt and "31107" in prompt and "Thailand Lubricating base oil" in prompt
    assert usage.recorded[-1]["kind"] == "trade_update"
    assert store.recorded[-1][1] == "asked for a trade insight"


def test_a_trade_insight_needs_a_title_and_figures():
    api, _ = build(driver=Reviewer())

    assert api.post("/api/engine/sites/baseoil/trade-insight", headers=HEADERS, json={"title": "x"}).status_code == 422
    assert api.post("/api/engine/sites/baseoil/trade-insight", headers=HEADERS, json={"figures": TRADE_FIGURES}).status_code == 422
