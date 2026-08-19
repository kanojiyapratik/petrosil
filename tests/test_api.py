"""The wire contract of /api/price-reviews.

baseoil calls this in production, so these tests exist to prove the Python
port answers with the same fields, the same statuses and the same envelope the
TypeScript version did. Cases ported from src/http/app.test.ts.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.gemini import AiCompletion, AiProviderError
from app.api import create_api

TOKEN = "test-api-token"

VALID_BODY = {
    "price_date": "2099-08-20",
    "rows": [
        {"location": "Singapore", "price": 845},
        {"location": "Mumbai", "price": 600},
        {"location": "Atlantis", "price": 500},
    ],
    "current_prices": [
        {"location": "Singapore", "price": 812},
        {"location": "Mumbai", "price": 600},
    ],
    "valid_locations": ["Singapore", "Mumbai"],
}


class StubDriver:
    def __init__(self, completion=None, raises=None):
        self._completion = completion or AiCompletion(
            status="complete",
            text="Prices rose modestly across the board.",
            prompt_tokens=300,
            completion_tokens=120,
            error=None,
        )
        self._raises = raises
        self.calls = []

    def generate(self, model, prompt):
        self.calls.append({"model": model, "prompt": prompt})

        if self._raises:
            raise self._raises

        return self._completion


def client_for(driver=None):
    app = FastAPI()
    app.include_router(
        create_api(api_token=TOKEN, driver=driver or StubDriver(), default_model="gemini-2.5-flash")
    )

    return TestClient(app)


def post(client, body=None, token=TOKEN):
    headers = {"authorization": f"Bearer {token}"} if token else {}

    return client.post("/api/price-reviews", json=body if body is not None else VALID_BODY, headers=headers)


class TestModels:
    def test_lists_the_configured_provider(self):
        response = client_for().get("/api/models", headers={"authorization": f"Bearer {TOKEN}"})

        assert response.status_code == 200
        google = next(p for p in response.json() if p["provider"] == "google")
        assert google["available"] is True
        assert "gemini-2.5-flash" in [m["key"] for m in google["models"]]

    def test_needs_a_token(self):
        assert client_for().get("/api/models").status_code == 401


class TestAuth:
    def test_rejects_a_missing_or_wrong_token(self):
        client = client_for()

        assert post(client, token=None).status_code == 401
        assert post(client, token="wrong-token").status_code == 401

    def test_fails_closed_when_no_token_is_configured(self):
        app = FastAPI()
        app.include_router(create_api(api_token="", driver=StubDriver(), default_model="m"))
        client = TestClient(app)

        assert client.post("/api/price-reviews", json=VALID_BODY).status_code == 401


class TestPriceReviews:
    def test_returns_the_rows_the_summary_and_the_narration(self):
        response = post(client_for())

        assert response.status_code == 201
        body = response.json()

        assert [row["location"] for row in body["rows"]] == ["Singapore", "Mumbai", "Atlantis"]
        assert [row["status"] for row in body["rows"]] == ["changed", "unchanged", "unmatched"]
        assert body["summary"]["total_rows"] == 3
        assert body["analysis"]["status"] == "complete"
        assert body["analysis"]["prompt_tokens"] == 300

    def test_uses_snake_case_on_the_wire(self):
        # The callers are PHP sites; camelCase would break every one of them.
        body = post(client_for()).json()

        assert set(body["rows"][0]) == {"location", "old_price", "new_price", "status"}
        assert "median_change_pct" in body["summary"]["changes"]
        assert "output_markdown" in body["analysis"]

    def test_a_model_decline_is_still_a_201(self):
        # The request succeeded; the model simply declined.
        driver = StubDriver(
            AiCompletion(
                status="declined",
                text=None,
                prompt_tokens=None,
                completion_tokens=None,
                error="The model declined to respond: SAFETY",
            )
        )
        response = post(client_for(driver))

        assert response.status_code == 201
        assert response.json()["analysis"]["status"] == "declined"

    def test_a_provider_failure_is_502_but_still_returns_the_diff(self):
        # The diff and the figures are this module's own work: they stay valid
        # even when the provider is unreachable.
        response = post(client_for(StubDriver(raises=AiProviderError("Gemini request failed"))))

        assert response.status_code == 502
        body = response.json()
        assert body["analysis"]["status"] == "failed"
        assert len(body["rows"]) == 3
        assert body["summary"]["total_rows"] == 3

    def test_rejects_a_bad_price_date(self):
        response = post(client_for(), {**VALID_BODY, "price_date": "20-08-2026"})

        assert response.status_code == 422

    def test_rejects_an_empty_row_list(self):
        assert post(client_for(), {**VALID_BODY, "rows": []}).status_code == 422

    def test_a_missing_price_key_becomes_invalid_not_zero(self):
        response = post(
            client_for(),
            {**VALID_BODY, "rows": [{"location": "Singapore"}], "valid_locations": ["Singapore"]},
        )

        assert response.json()["rows"][0]["status"] == "invalid"

    def test_the_model_is_given_the_figures_not_the_rows(self):
        driver = StubDriver()
        post(client_for(driver))

        prompt = driver.calls[0]["prompt"]
        assert "total_rows" in prompt
        assert "suspected_errors" in prompt
        # The raw rows would let it recount; it is given the computed figures.
        assert "valid_locations" not in prompt

    def test_the_caller_can_choose_the_model(self):
        driver = StubDriver()
        post(client_for(driver), {**VALID_BODY, "model": "gemini-2.5-pro"})

        assert driver.calls[0]["model"] == "gemini-2.5-pro"
        assert post(client_for(driver)).json()["analysis"]["model"] == "gemini-2.5-flash"


class TestEntryPoints:
    """The module is opened in a browser as often as it is called by a site.

    These drive the real create_app(), not a stand-in, because the point is
    what someone gets when they open the deployment's URL.
    """

    def _client(self, monkeypatch):
        from app.main import create_app

        monkeypatch.setenv("PRICE_API_TOKEN", TOKEN)
        monkeypatch.setenv("GOOGLE_GENERATIVE_AI_API_KEY", "k")
        # No DATABASE_URL: the console stays off, so this needs no database.
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("CONSOLE_SECRET", raising=False)

        return TestClient(create_app())

    def test_the_root_sends_a_browser_to_the_console(self, monkeypatch):
        # It used to answer {"detail":"Not Found"}, which reads as a broken
        # deployment rather than "you want /console".
        response = self._client(monkeypatch).get("/", follow_redirects=False)

        assert response.status_code == 307
        assert response.headers["location"] == "/console"

    def test_an_unknown_page_is_a_page_not_json(self, monkeypatch):
        response = self._client(monkeypatch).get("/nonsense")

        assert response.status_code == 404
        assert "text/html" in response.headers["content-type"]
        assert "Go to the console" in response.text

    def test_an_unknown_api_path_is_still_json(self, monkeypatch):
        # The callers there are PHP sites parsing JSON.
        response = self._client(monkeypatch).get("/api/nonsense")

        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}

    def test_health_answers_without_a_token(self, monkeypatch):
        assert self._client(monkeypatch).get("/health").json() == {"ok": True}
