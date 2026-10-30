"""The engine's JSON face for the app's AI tools tab (app/console/engine_api.py).

The steps themselves are the console's, already covered by test_reading_routes
and test_editorial; what is pinned here is the door: only the app's token,
only with a named person, only this site's readings and drafts, the console's
words and statuses on refusal -- and that the person named is the one the
audit trail and the draft record.
"""

from __future__ import annotations

import dataclasses
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.console.engine_api import create_engine_api
from app.db.store import ReadingSet, ReadRow, StoredDraft
from test_editorial import (
    AnalyseFakeExtractions,
    AnalyseFakeRounding,
    AnalyseFakeRules,
    AnalyseFakeSiteClient,
    AnalyseFakeStore,
    FakeDrafts,
    StubDriver as DraftDriver,
    build_docx,
    kept_and_dropped_rows,
)
from test_reading_routes import FakeExtractions, StubDriver as ReadingDriver

TOKEN = "engine-test-token"
ACTOR = "editor@petrosil.example"
HEADERS = {"authorization": f"Bearer {TOKEN}", "x-acting-user": ACTOR}


class Drafts(FakeDrafts):
    """FakeDrafts, plus the two reads the API makes of a kept draft."""

    def draft(self, draft_id, site_slug):
        if draft_id != self._draft_id or site_slug != self._owner:
            return None

        return StoredDraft(
            id=draft_id, site_slug=site_slug, reading_set_id=7, created_by=ACTOR, created_at=None,
            price_date="2026-10-30", provider="openai", model="gpt-4.1", analysis_status="complete",
            batch_id=None, saved_by=None, saved_at=None, rows=[],
        )

    def recent(self, site_slug, limit=20):
        return [{"id": self._draft_id, "created_by": ACTOR}] if site_slug == self._owner else []

    def latest_for_reading(self, site_slug, reading_set_id):
        return None


def build(*, extractions=None, driver=None, driver_for=None, drafts=None, client=None, store=None):
    store = store or AnalyseFakeStore()
    client = client or AnalyseFakeSiteClient([{"title": "Europe Domestic SN150", "latest_price": 1000.0}])
    app = FastAPI()
    app.include_router(
        create_engine_api(
            api_token=TOKEN,
            store=store,
            extractions=extractions if extractions is not None else FakeExtractions(),
            drafts=drafts if drafts is not None else Drafts(),
            driver=driver or DraftDriver(),
            default_model="gemini-2.5-flash",
            driver_for=driver_for,
            rules=AnalyseFakeRules([]),
            rounding=AnalyseFakeRounding({}),
            client_factory=lambda site: client,
        )
    )

    return TestClient(app), store, client


# ----------------------------------------------------------------- the door


class TestOnlyTheAppActingForSomeone:
    def test_no_token_is_refused(self):
        api, _, _ = build()

        assert api.get("/api/engine/sites/baseoil/drafts", headers={"x-acting-user": ACTOR}).status_code == 401

    def test_a_wrong_token_is_refused(self):
        api, _, _ = build()
        headers = {"authorization": "Bearer nope", "x-acting-user": ACTOR}

        assert api.get("/api/engine/sites/baseoil/drafts", headers=headers).status_code == 401

    def test_an_empty_configured_token_refuses_everyone(self):
        app = FastAPI()
        app.include_router(
            create_engine_api(
                api_token="", store=AnalyseFakeStore(), extractions=FakeExtractions(),
                drafts=Drafts(), driver=DraftDriver(), default_model="m",
            )
        )
        headers = {"authorization": "Bearer ", "x-acting-user": ACTOR}

        assert TestClient(app).get("/api/engine/sites/baseoil/drafts", headers=headers).status_code == 401

    def test_nobody_named_is_refused_because_the_audit_trail_needs_a_name(self):
        api, _, _ = build()
        headers = {"authorization": f"Bearer {TOKEN}"}

        assert api.get("/api/engine/sites/baseoil/drafts", headers=headers).status_code == 400

    def test_an_unknown_site_is_a_404(self):
        api, _, _ = build()

        assert api.get("/api/engine/sites/nowhere/drafts", headers=HEADERS).status_code == 404


# -------------------------------------------------------------- the screen


class TestTheInstructions:
    def test_saving_them_is_recorded_in_the_actors_name(self):
        api, store, _ = build()

        response = api.put(
            "/api/engine/sites/baseoil/instructions", headers=HEADERS,
            json={"instructions": "  Read the euro column.  "},
        )

        assert response.status_code == 200
        assert response.json() == {"instructions": "Read the euro column."}
        assert store.site.editorial_instructions == "Read the euro column."
        assert store.recorded[-1][0] == ACTOR

    def test_the_overview_carries_them_and_the_limits(self):
        api, _, _ = build(extractions=AnalyseFakeExtractions(kept_and_dropped_rows()))
        extractions_view = api.get("/api/engine/sites/baseoil/editorial", headers=HEADERS).json()

        assert extractions_view["site"]["instructions"] == "Ignore last week's recap."
        assert extractions_view["limits"] == {"documents": 5, "bytes": 10 * 1024 * 1024}


# ---------------------------------------------------------------- reading


class TestReading:
    def test_each_file_is_read_and_the_rows_come_back_grouped_by_file(self):
        extractions = FakeExtractions()
        driver = ReadingDriver()
        api, store, _ = build(extractions=extractions, driver=driver, driver_for=lambda slug: driver)
        report = build_docx(["FOB Asia SN 150 was assessed at $1,260/t."])

        response = api.post(
            "/api/engine/sites/baseoil/readings", headers=HEADERS,
            files=[("documents", ("lube.docx", report, "application/octet-stream"))],
        )

        assert response.status_code == 201
        body = response.json()
        assert body["failures"] == []
        assert [f["filename"] for f in body["reading"]["files"]] == ["lube.docx"]
        assert body["reading"]["files"][0]["rows"][0]["name"] == "FOB Asia SN 150"
        assert extractions.sets[1].created_by == ACTOR
        assert store.recorded[-1][:2] == (ACTOR, "read reports")

    def test_instructions_sent_with_a_run_are_used_for_that_run_only(self):
        extractions = FakeExtractions()
        driver = ReadingDriver()
        api, store, _ = build(extractions=extractions, driver=driver, driver_for=lambda slug: driver)

        api.post(
            "/api/engine/sites/baseoil/readings", headers=HEADERS,
            data={"instructions": "Only the dollar column."},
            files=[("documents", ("a.docx", build_docx(["SN 150 $1,260/t"]), "application/octet-stream"))],
        )

        assert extractions.opened_with == "Only the dollar column."
        assert store.site.editorial_instructions == "Ignore last week's recap."

    def test_no_file_and_too_many_files_are_refused_in_the_consoles_words(self):
        api, _, _ = build()
        none = api.post("/api/engine/sites/baseoil/readings", headers=HEADERS, data={})
        six = api.post(
            "/api/engine/sites/baseoil/readings", headers=HEADERS,
            files=[("documents", (f"r{i}.txt", b"x", "text/plain")) for i in range(6)],
        )

        assert (none.status_code, none.json()) == (422, {"error": "Choose at least one report."})
        assert (six.status_code, six.json()) == (422, {"error": "At most 5 reports at a time."})

    def test_another_sites_reading_is_not_found(self):
        extractions = FakeExtractions()
        extractions.sets[3] = ReadingSet(id=3, site_slug="bitumart", created_by="x", created_at=None, files=[])
        api, _, _ = build(extractions=extractions)

        assert api.get("/api/engine/sites/baseoil/readings/3", headers=HEADERS).status_code == 404


class TestCorrectingRows:
    def setup_method(self):
        self.extractions = FakeExtractions()
        reading = self.extractions.open_set("baseoil", ACTOR)
        self.extractions.add_rows(reading.id, "lube.docx", [{"name": "FOB Asia SN 150", "price": 1260.0}])
        self.api, self.store, _ = build(extractions=self.extractions)

    def test_a_correction_goes_through_the_consoles_own_checks(self):
        bad = self.api.patch(
            "/api/engine/sites/baseoil/readings/1/rows/1", headers=HEADERS,
            json={"name": "FOB Asia SN 150", "price": "twelve", "kept": True},
        )
        nameless = self.api.patch(
            "/api/engine/sites/baseoil/readings/1/rows/1", headers=HEADERS,
            json={"name": " ", "price": 1250, "kept": True},
        )
        bad_day = self.api.patch(
            "/api/engine/sites/baseoil/readings/1/rows/1", headers=HEADERS,
            json={"name": "FOB Asia SN 150", "price": 1250, "price_date": "2026-02-31", "kept": True},
        )

        assert (bad.status_code, bad.json()["error"]) == (422, "That price is not a number.")
        assert nameless.json()["error"].startswith("That row needs a name")
        assert bad_day.json()["error"] == "That date is not a real day in YYYY-MM-DD form."
        assert self.extractions.updated == []

    def test_dropping_a_row_is_kept_false(self):
        response = self.api.patch(
            "/api/engine/sites/baseoil/readings/1/rows/1", headers=HEADERS,
            json={"name": "FOB Asia SN 150", "price": 1250, "kept": False},
        )

        assert response.status_code == 200
        assert self.extractions.updated == [(1, {**self.extractions.updated[0][1], "kept": False})]
        assert self.extractions.updated[0][1]["price"] == 1250.0

    def test_a_row_from_another_reading_is_not_found(self):
        other = self.extractions.open_set("baseoil", ACTOR)

        response = self.api.patch(
            f"/api/engine/sites/baseoil/readings/{other.id}/rows/1", headers=HEADERS,
            json={"name": "x", "price": 1, "kept": True},
        )

        assert response.status_code == 404

    def test_a_missed_price_is_added_under_its_file_in_the_actors_name(self):
        response = self.api.post(
            "/api/engine/sites/baseoil/readings/1/rows", headers=HEADERS,
            json={"file_id": 1, "name": "Europe Domestic SN150", "price": 1010, "currency": "EUR", "kept": True},
        )

        assert response.status_code == 201
        assert self.extractions.inserted[0][1:] == ("lube.docx", self.extractions.inserted[0][2], 1)
        assert self.extractions.inserted[0][2]["currency"] == "EUR"
        assert self.store.recorded[-1][:2] == (ACTOR, "added a price")

    def test_a_row_for_a_file_not_in_the_reading_is_refused(self):
        response = self.api.post(
            "/api/engine/sites/baseoil/readings/1/rows", headers=HEADERS,
            json={"filename": "elsewhere.pdf", "name": "x", "price": 5, "kept": True},
        )

        assert response.json() == {"error": "That price could not be added to any of these reports."}


# --------------------------------------------------------------- drafting


class TestDrafting:
    def test_a_draft_is_made_and_kept_in_the_actors_name(self):
        drafts = Drafts()
        api, _, _ = build(extractions=AnalyseFakeExtractions(kept_and_dropped_rows()), drafts=drafts)

        response = api.post(
            "/api/engine/sites/baseoil/drafts", headers=HEADERS,
            json={"set_id": 7, "pricedate": "2026-10-30"},
        )

        assert response.status_code == 201
        body = response.json()
        assert body["draft_id"] == 12
        assert body["pricedate"] == "2026-10-30"
        assert {"rows", "summary", "findings", "blockers", "analysis"} <= body.keys()
        assert json.dumps(body)  # every value made it into JSON
        assert drafts.created[0]["created_by"] == ACTOR

    def test_a_used_reading_answers_409_with_what_reusing_it_needs(self):
        extractions = AnalyseFakeExtractions(kept_and_dropped_rows())
        api, _, _ = build(extractions=extractions)
        api.post("/api/engine/sites/baseoil/drafts", headers=HEADERS, json={"set_id": 7})

        again = api.post("/api/engine/sites/baseoil/drafts", headers=HEADERS, json={"set_id": 7})

        assert again.status_code == 409
        assert again.json()["error"] == "Those prices have already been used."
        assert again.json()["reuse"]["set_id"] == 7

    def test_another_sites_reading_is_not_drafted(self):
        api, _, _ = build(extractions=AnalyseFakeExtractions(kept_and_dropped_rows(), site_slug="bitumart"))

        response = api.post("/api/engine/sites/baseoil/drafts", headers=HEADERS, json={"set_id": 7})

        assert (response.status_code, response.json()) == (404, {"error": "That reading could not be found."})

    def test_a_reading_with_nothing_kept_is_refused(self):
        dropped = [dataclasses.replace(row, kept=False) for row in kept_and_dropped_rows()]
        api, _, _ = build(extractions=AnalyseFakeExtractions(dropped))

        response = api.post("/api/engine/sites/baseoil/drafts", headers=HEADERS, json={"set_id": 7})

        assert response.status_code == 422


class TestSaving:
    def test_kept_rows_become_a_draft_price_update_linked_to_the_ai_draft(self):
        drafts = Drafts()
        client = AnalyseFakeSiteClient([])
        api, store, _ = build(drafts=drafts, client=client)

        response = api.post(
            "/api/engine/sites/baseoil/drafts/12/save", headers=HEADERS,
            json={
                "pricedate": "2026-10-30",
                "rows": [
                    {"location": "Europe Domestic SN150", "price": 1010},
                    {"location": "Korea SN 150", "price": "1404", "calculation": "Singapore 1560 -10%"},
                    {"location": "", "price": 5},
                    {"location": "Broken", "price": "abc"},
                ],
            },
        )

        assert response.status_code == 201
        assert response.json() == {"batch_id": 31, "saved": 2}
        assert client.staged == [
            {"location": "Europe Domestic SN150", "price": 1010.0},
            {"location": "Korea SN 150", "price": 1404.0},
        ]
        assert drafts.saved[0]["saved_by"] == ACTOR
        assert (ACTOR, "saved a derived price", "baseoil", "batch #31: Korea SN 150 = 1404: Singapore 1560 -10%") in store.recorded

    def test_nothing_ticked_is_refused_and_nothing_staged(self):
        client = AnalyseFakeSiteClient([])
        api, _, _ = build(client=client)

        response = api.post("/api/engine/sites/baseoil/drafts/12/save", headers=HEADERS, json={"rows": []})

        assert (response.status_code, response.json()) == (422, {"error": "Tick at least one row with a price to stage."})
        assert not hasattr(client, "staged")

    def test_another_sites_draft_cannot_be_saved(self):
        api, _, _ = build(drafts=Drafts(owner="bitumart"))

        response = api.post(
            "/api/engine/sites/baseoil/drafts/12/save", headers=HEADERS,
            json={"rows": [{"location": "x", "price": 1}]},
        )

        assert response.status_code == 404

    def test_a_kept_draft_comes_back_with_its_checks_so_a_page_can_reload(self):
        api, _, _ = build()

        body = api.get("/api/engine/sites/baseoil/drafts/12", headers=HEADERS).json()

        assert body["draft"]["id"] == 12
        assert body["draft"]["model"] == "gpt-4.1"
        assert (body["findings"], body["blockers"]) == ([], 0)

    def test_another_sites_draft_is_not_shown(self):
        api, _, _ = build(drafts=Drafts(owner="bitumart"))

        assert api.get("/api/engine/sites/baseoil/drafts/12", headers=HEADERS).status_code == 404

    def test_the_draft_list_is_this_sites(self):
        api, _, _ = build()

        assert api.get("/api/engine/sites/baseoil/drafts", headers=HEADERS).json() == {
            "drafts": [{"id": 12, "created_by": ACTOR}]
        }


def test_a_row_dataclass_survives_the_trip_to_json():
    """ReadRow and friends leave as plain objects, not reprs."""
    from app.console.engine_api import jsonable

    row = ReadRow(
        id=1, set_id=2, filename="f", name="n", price=1.5, price_min=None, price_max=None,
        currency="USD", unit=None, basis=None, price_date=None, note=None, kept=True,
    )

    assert jsonable([row])[0]["price"] == 1.5


class TestTheNoteAfterACommit:
    def test_the_app_can_ask_for_it_and_a_failure_stays_quiet(self):
        class Client(AnalyseFakeSiteClient):
            def batch(self, batch_id):
                raise RuntimeError("the site is down")

        api, store, _ = build(client=Client([]))

        response = api.post("/api/engine/sites/baseoil/batches/31/note", headers=HEADERS)

        assert response.status_code == 202
        assert store.recorded[-1][:2] == (ACTOR, "asked for the price note")
