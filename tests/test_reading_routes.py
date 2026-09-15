"""Reading the uploaded reports, one AI call per file.

The reason the calls are separate: a single prompt holding five reports is
65k characters and gets skimmed -- measured, gpt-4o-mini returned 0
suggestions across 47 locations. One report per call is small enough to be
read properly, and it makes plain which file gave what.
"""

import dataclasses
import io
import json

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.ai.providers import AiCompletion, AiProviderError
from app.console.routes_reading import create_reading_routes
from app.db.store import ReadingSet, ReadRow, StoredSite

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
)

ANSWER = json.dumps([{"name": "FOB Asia SN 150", "price": 1260, "currency": "USD"}])


class FakeStore:
    def site_by_slug(self, slug):
        return SITE if slug == SITE.slug else None

    def record(self, *args, **kwargs):
        pass


class FakeExtractions:
    def __init__(self):
        self.sets = {}
        self.added = []
        self.updated = []
        self._next = 1

    def open_set(self, site_slug, created_by):
        made = ReadingSet(
            id=self._next, site_slug=site_slug, created_by=created_by,
            created_at=None, files=[],
        )
        self.sets[self._next] = made
        self._next += 1

        return made

    def add_rows(self, set_id, filename, rows):
        self.added.append((filename, rows))

    def set_by_id(self, set_id):
        return self.sets.get(set_id)

    def rows_for(self, set_id):
        return [
            ReadRow(
                id=index + 1, set_id=set_id, filename=filename, name=row["name"],
                price=row["price"], price_min=None, price_max=None,
                currency=row.get("currency"), unit=None, basis=None,
                price_date=None, note=None, kept=True,
            )
            for index, (filename, rows) in enumerate(self.added)
            for row in rows
        ]

    def update_row(self, row_id, **fields):
        self.updated.append((row_id, fields))


class StubDriver:
    provider_key = "openai"
    model = "gpt-4o-mini"

    def __init__(self, answers=None, raises=None):
        self._answers = list(answers or [ANSWER])
        self._raises = raises
        self.prompts = []

    def generate(self, prompt):
        self.prompts.append(prompt)

        if self._raises:
            raise self._raises

        text = self._answers.pop(0) if self._answers else ANSWER

        return AiCompletion(
            status="complete", text=text, prompt_tokens=1, completion_tokens=1, error=None,
        )


def build(driver=None, extractions=None):
    extractions = extractions or FakeExtractions()
    app = FastAPI()
    app.include_router(
        create_reading_routes(
            store=FakeStore(),
            extractions=extractions,
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True}
            )(),
            driver=driver or StubDriver(),
            default_model="gpt-4o-mini",
            driver_for=lambda: driver or StubDriver(),
        )
    )

    return TestClient(app), extractions


def upload(client, files):
    return client.post(
        "/console/sites/baseoil/reading",
        files=[("documents", (name, io.BytesIO(body), "text/plain")) for name, body in files],
        follow_redirects=False,
    )


class TestReadingEachFileOnItsOwn:
    def test_each_file_is_one_call_with_only_its_own_text_in_it(self):
        driver = StubDriver(answers=[ANSWER, ANSWER])
        client, _ = build(driver)

        upload(client, [("first.txt", b"FOB Asia SN 150 1260"), ("second.txt", b"Izmir 81212")])

        assert len(driver.prompts) == 2
        assert "FOB Asia SN 150 1260" in driver.prompts[0]
        assert "Izmir" not in driver.prompts[0]

    def test_the_rows_are_stored_under_the_file_they_came_from(self):
        client, extractions = build()

        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        assert extractions.added[0][0] == "lube.txt"
        assert extractions.added[0][1][0]["name"] == "FOB Asia SN 150"

    def test_a_file_the_model_found_nothing_in_is_still_recorded_as_read(self):
        client, extractions = build(StubDriver(answers=["[]"]))

        upload(client, [("empty.txt", b"no prices here")])

        assert extractions.added == [("empty.txt", [])]

    def test_one_unreadable_file_does_not_lose_the_others(self):
        # Four good reports must not be thrown away by the fifth failing.
        class Flaky(StubDriver):
            def generate(self, prompt):
                if "second" in prompt:
                    raise AiProviderError("provider is down")

                return super().generate(prompt)

        client, extractions = build(Flaky(answers=[ANSWER, ANSWER]))

        response = upload(
            client, [("first.txt", b"FOB Asia SN 150 1260"), ("second.txt", b"x")]
        )

        assert response.status_code in (200, 303)
        assert extractions.added[0][0] == "first.txt"

    def test_more_than_five_files_is_refused(self):
        client, extractions = build()

        response = upload(client, [(f"{n}.txt", b"x") for n in range(6)])

        assert response.status_code == 422
        assert extractions.added == []

    def test_no_file_at_all_is_refused(self):
        client, extractions = build()

        response = client.post("/console/sites/baseoil/reading", follow_redirects=False)

        assert response.status_code == 422
        assert extractions.added == []


class TestCheckingWhatWasRead:
    def test_the_screen_shows_each_file_and_its_rows(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert "lube.txt" in page
        assert "FOB Asia SN 150" in page

    def test_a_figure_can_be_corrected(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "1300", "kept": "1"},
            follow_redirects=False,
        )

        assert extractions.updated[0][1]["price"] == 1300.0

    def test_a_row_can_be_dropped(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "1260"},
            follow_redirects=False,
        )

        assert extractions.updated[0][1]["kept"] is False

    def test_a_correction_that_is_not_a_number_changes_nothing(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "about 1300", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []


class ScopedExtractions:
    """Like FakeExtractions, but a row only ever answers to the set that made it.

    FakeExtractions (the spec's own fake) tags every row returned by rows_for()
    with whatever set_id was asked for, regardless of which set actually made
    it -- fine for the tests above, but useless for proving a row from one
    reading cannot be edited through a different reading's URL.
    """

    def __init__(self):
        self.sets = {}
        self.rows_by_set = {}
        self.updated = []
        self._next_set = 1
        self._next_row = 1

    def open_set(self, site_slug, created_by):
        made = ReadingSet(
            id=self._next_set, site_slug=site_slug, created_by=created_by,
            created_at=None, files=[],
        )
        self.sets[self._next_set] = made
        self.rows_by_set[self._next_set] = []
        self._next_set += 1

        return made

    def add_rows(self, set_id, filename, rows):
        for row in rows:
            self.rows_by_set[set_id].append(
                ReadRow(
                    id=self._next_row, set_id=set_id, filename=filename, name=row["name"],
                    price=row["price"], price_min=None, price_max=None,
                    currency=row.get("currency"), unit=None, basis=None,
                    price_date=None, note=None, kept=True,
                )
            )
            self._next_row += 1

    def set_by_id(self, set_id):
        return self.sets.get(set_id)

    def rows_for(self, set_id):
        return list(self.rows_by_set.get(set_id, []))

    def update_row(self, row_id, **fields):
        self.updated.append((row_id, fields))


class TestEditRowIsGuarded:
    def test_a_row_from_another_sites_reading_is_refused(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])
        # The reading exists, but under a different site than the one in the URL.
        extractions.sets[1] = dataclasses.replace(extractions.sets[1], site_slug="other-site")

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "1300", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 404
        assert extractions.updated == []

    def test_a_row_from_a_different_reading_is_refused(self):
        client, extractions = build(extractions=ScopedExtractions())
        upload(client, [("first.txt", b"FOB Asia SN 150 1260")])
        upload(client, [("second.txt", b"FOB Asia SN 150 1260")])

        # Row 2 belongs to reading #2, not reading #1.
        response = client.post(
            "/console/sites/baseoil/reading/1/rows/2",
            data={"name": "FOB Asia SN 150", "price": "1300", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 404
        assert extractions.updated == []

    def test_a_bad_range_value_is_a_422_not_a_500(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1300", "price_min": "cheap", "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []

    def test_a_garbled_date_is_a_422_not_saved(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1300", "price_date": "12th Aug",
                "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []

    def test_a_well_formed_date_is_saved(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1300", "price_date": "2026-08-19",
                "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert extractions.updated[0][1]["price_date"] == "2026-08-19"


class TestTheReadingIsRecorded:
    def test_every_file_read_is_recorded_as_usage(self):
        seen = []

        class Usage:
            def record(self, **kwargs):
                seen.append(kwargs["kind"])

        app = FastAPI()
        app.include_router(
            create_reading_routes(
                store=FakeStore(),
                extractions=FakeExtractions(),
                templates=Jinja2Templates(directory="app/templates"),
                current_user=lambda request: type("U", (), {"email": "a@b.test", "name": "A", "is_admin": True})(),
                driver=StubDriver(),
                default_model="gpt-4o-mini",
                driver_for=lambda: StubDriver(),
                usage=Usage(),
            )
        )
        upload(TestClient(app), [("lube.txt", b"FOB Asia SN 150 1260")])

        assert "extract_file" in seen

    def test_a_broken_recorder_never_costs_the_reading(self):
        class Exploding:
            def record(self, **kwargs):
                raise RuntimeError("ledger down")

        app = FastAPI()
        extractions = FakeExtractions()
        app.include_router(
            create_reading_routes(
                store=FakeStore(),
                extractions=extractions,
                templates=Jinja2Templates(directory="app/templates"),
                current_user=lambda request: type("U", (), {"email": "a@b.test", "name": "A", "is_admin": True})(),
                driver=StubDriver(),
                default_model="gpt-4o-mini",
                driver_for=lambda: StubDriver(),
                usage=Exploding(),
            )
        )
        upload(TestClient(app), [("lube.txt", b"FOB Asia SN 150 1260")])

        assert extractions.added[0][0] == "lube.txt"
