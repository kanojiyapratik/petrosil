"""Reading the uploaded reports, one AI call per file.

The reason the calls are separate: a single prompt holding five reports is
65k characters and gets skimmed -- measured, gpt-4o-mini returned 0
suggestions across 47 locations. One report per call is small enough to be
read properly, and it makes plain which file gave what.
"""

import dataclasses
import io
import json
import re

from urllib.parse import unquote_plus

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.ai.providers import AiCompletion, AiProviderError
from app.console.routes_reading import create_reading_routes
from app.db.store import ReadFile, ReadingSet, ReadRow, StoredSite

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
)

ANSWER = json.dumps([{"name": "FOB Asia SN 150", "price": 1260, "currency": "USD"}])
RANGE_ANSWER = json.dumps(
    [
        {
            "name": "FOB Asia SN 150", "price": 1550, "price_min": 1540,
            "price_max": 1560, "currency": "USD",
        }
    ]
)


class FakeStore:
    def __init__(self, site=SITE):
        self.site = site
        self.recorded = []

    def site_by_slug(self, slug):
        return self.site if slug == self.site.slug else None

    def record(self, *args, **kwargs):
        self.recorded.append(args)


class FakeExtractions:
    """Keeps what it is given, the way the real store does: a file is a row
    of its own (two uploads can share a name), and every price row remembers
    which file row it came out of."""

    def __init__(self):
        self.sets = {}
        self.added = []
        self.updated = []
        self.inserted = []
        self._rows = {}
        self._next_set = 1
        self._next_file = 1
        self._next_row = 1

    def open_set(self, site_slug, created_by):
        made = ReadingSet(
            id=self._next_set, site_slug=site_slug, created_by=created_by,
            created_at=None, files=[],
        )
        self.sets[self._next_set] = made
        self._rows[self._next_set] = []
        self._next_set += 1

        return made

    def add_rows(self, set_id, filename, rows):
        self.added.append((filename, rows))
        file_id = self._next_file
        self._next_file += 1
        held = self.sets[set_id]
        self.sets[set_id] = dataclasses.replace(
            held, files=[*held.files, ReadFile(id=file_id, filename=filename)]
        )

        for row in rows:
            self._keep(set_id, file_id, filename, row)

    def add_row(self, set_id, filename, row, file_id=None):
        self.inserted.append((set_id, filename, row, file_id))
        self._keep(set_id, file_id, filename, row)

    def _keep(self, set_id, file_id, filename, row):
        self._rows.setdefault(set_id, []).append(
            ReadRow(
                id=self._next_row, set_id=set_id, filename=filename, name=row["name"],
                price=row["price"], price_min=row.get("price_min"),
                price_max=row.get("price_max"), currency=row.get("currency"),
                unit=row.get("unit"), basis=row.get("basis"),
                price_date=row.get("price_date"), note=row.get("note"),
                kept=row.get("kept", True), file_id=file_id,
            )
        )
        self._next_row += 1

    def set_by_id(self, set_id):
        return self.sets.get(set_id)

    def rows_for(self, set_id):
        return list(self._rows.get(set_id, []))

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


def build(driver=None, extractions=None, store=None):
    extractions = extractions or FakeExtractions()
    app = FastAPI()
    app.include_router(
        create_reading_routes(
            store=store or FakeStore(),
            extractions=extractions,
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True, "is_superadmin": True}
            )(),
            driver=driver or StubDriver(),
            default_model="gpt-4o-mini",
            driver_for=lambda *_: driver or StubDriver(),
        )
    )

    return TestClient(app), extractions


def upload(client, files, pricedate=None, use_instructions=True):
    """An upload as the form sends one.

    `use_instructions` is the tick on the upload screen, which is on by
    default: the saved rulebook is what an editor normally wants sent, and
    the box exists so they can see it and say otherwise. An unticked
    checkbox posts nothing at all, which is why "off" means leaving the
    field out rather than sending a false.
    """
    data = {}

    if pricedate:
        data["pricedate"] = pricedate

    if use_instructions:
        data["use_instructions"] = "on"

    return client.post(
        "/console/sites/baseoil/reading",
        files=[("documents", (name, io.BytesIO(body), "text/plain")) for name, body in files],
        data=data or None,
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

        assert response.status_code == 303
        assert extractions.added == []

    def test_no_file_at_all_is_refused(self):
        client, extractions = build()

        response = client.post("/console/sites/baseoil/reading", follow_redirects=False)

        assert response.status_code == 303
        assert extractions.added == []


class TestARefusedUploadLandsWhereTheUploadFormIs:
    """Rendering reading.html with no reading gave a page headed "Check what
    was read" saying "Nothing has been read yet" -- and no upload form, which
    lives on the editorial screen. The refusal now goes back there, the way
    `stage` already reports its errors."""

    def test_no_file_redirects_to_the_upload_screen_with_the_reason(self):
        client, extractions = build()

        response = client.post("/console/sites/baseoil/reading", follow_redirects=False)

        assert response.status_code == 303
        location = response.headers["location"]
        assert location.startswith("/console/sites/baseoil/editorial?err=")
        assert "Choose%20at%20least%20one%20report." in location

    def test_too_many_files_redirects_to_the_upload_screen_with_the_reason(self):
        client, extractions = build()

        response = upload(client, [(f"{n}.txt", b"x") for n in range(6)])

        assert response.status_code == 303
        assert response.headers["location"].startswith(
            "/console/sites/baseoil/editorial?err="
        )
        assert "At%20most%205%20reports" in response.headers["location"]


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
                current_user=lambda request: type("U", (), {"email": "a@b.test", "name": "A", "is_admin": True, "is_superadmin": True})(),
                driver=StubDriver(),
                default_model="gpt-4o-mini",
                driver_for=lambda *_: StubDriver(),
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
                current_user=lambda request: type("U", (), {"email": "a@b.test", "name": "A", "is_admin": True, "is_superadmin": True})(),
                driver=StubDriver(),
                default_model="gpt-4o-mini",
                driver_for=lambda *_: StubDriver(),
                usage=Exploding(),
            )
        )
        upload(TestClient(app), [("lube.txt", b"FOB Asia SN 150 1260")])

        assert extractions.added[0][0] == "lube.txt"


class TestThePriceDateCarriesThrough:
    """The upload form's own pricedate field used to be dropped entirely
    once the form started posting here -- the analyse route defaulted to
    today, silently, however carefully the editor set it."""

    def test_the_chosen_date_is_on_the_redirect_and_prefills_the_foot_form(self):
        client, extractions = build()

        response = upload(client, [("lube.txt", b"FOB Asia SN 150 1260")], pricedate="2026-08-12")

        assert response.status_code == 303
        assert "pricedate=2026-08-12" in response.headers["location"]

        page = client.get(response.headers["location"]).text

        assert 'name="pricedate" value="2026-08-12"' in page

    def test_without_a_chosen_date_it_falls_back_to_today(self):
        import datetime

        client, extractions = build()

        response = upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])
        page = client.get(response.headers["location"]).text

        assert f'name="pricedate" value="{datetime.date.today().isoformat()}"' in page

    def test_a_row_correction_does_not_reset_the_chosen_date(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")], pricedate="2026-08-12")

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1300", "kept": "1",
                "pricedate": "2026-08-12",
            },
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert "pricedate=2026-08-12" in response.headers["location"]

        page = client.get(response.headers["location"]).text
        assert 'name="pricedate" value="2026-08-12"' in page

        # The foot form carries the date too, so the assertions above stay
        # green if the per-row hidden field is deleted -- and the date then
        # silently resets to today on the next correction, which silently
        # picks today's ECB rate. Pin the hidden field itself.
        assert 'type="hidden" name="pricedate" value="2026-08-12"' in page


class TestTheWholeRangeIsVisibleAndCorrectable:
    """The range used to ride each row as two hidden inputs: never shown,
    never editable, stored, and handed to the analysis -- which turns them
    back into the staged midpoint. A report printing 1,450-1,500 misread as
    1,540-1,560 showed a single Price box saying 1540; correcting it to 1450
    left 1540/1560 untouched, and 1550 was staged. The correction changed
    nothing, and nothing said so."""

    def test_min_and_max_are_editable_boxes_not_hidden_fields(self):
        client, extractions = build(StubDriver(answers=[RANGE_ANSWER]))
        upload(client, [("lube.txt", b"FOB Asia SN 150 1540-1560")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert '<th>Min</th>' in page
        assert '<th>Max</th>' in page
        assert 'type="hidden" name="price_min"' not in page
        assert 'type="hidden" name="price_max"' not in page
        assert 'type="number" step="any" name="price_min" value="1540.0"' in page
        assert 'type="number" step="any" name="price_max" value="1560.0"' in page

    def test_a_corrected_range_is_what_gets_saved(self):
        client, extractions = build(StubDriver(answers=[RANGE_ANSWER]))
        upload(client, [("lube.txt", b"FOB Asia SN 150 1540-1560")])

        client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1475", "price_min": "1450",
                "price_max": "1500", "kept": "1",
            },
            follow_redirects=False,
        )

        saved = extractions.updated[0][1]
        assert (saved["price_min"], saved["price_max"]) == (1450.0, 1500.0)


class TestTheNoteIsVisibleAndCorrectable:
    """note already rode every row -- stored, round-tripped through
    edit_row, and sent to step two's model -- but only as a hidden field
    nobody could see or fix. That is the same defect as the hidden Min/Max
    above: a BASIC/TOTAL pair reads as two rows with the same name, price
    and unit, distinguished only by note, and an editor with no way to see
    or correct it cannot tell them apart either."""

    def test_note_is_an_editable_box_not_a_hidden_field(self):
        answer = json.dumps(
            [{"name": "Bit Bulk VG10", "price": 69100, "note": "BASIC"}]
        )
        client, extractions = build(StubDriver(answers=[answer]))
        upload(client, [("bpcl.txt", b"Bit Bulk VG10 69,100 BASIC")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert "<th>Note</th>" in page
        assert 'type="hidden" name="note"' not in page
        assert 'type="text" name="note" value="BASIC"' in page

    def test_a_correction_to_the_note_is_saved(self):
        answer = json.dumps(
            [{"name": "Bit Bulk VG10", "price": 69100, "note": "BASIC"}]
        )
        client, extractions = build(StubDriver(answers=[answer]))
        upload(client, [("bpcl.txt", b"Bit Bulk VG10 69,100 BASIC")])

        client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "Bit Bulk VG10", "price": "69100", "note": "BASIC, pre-tax",
                "kept": "1",
            },
            follow_redirects=False,
        )

        assert extractions.updated[0][1]["note"] == "BASIC, pre-tax"

    def test_the_add_a_price_form_also_has_a_note_field(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert 'name="note"' in page
        assert "Note</label>" in page

    def test_a_typed_price_can_carry_a_note(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])
        file_id = extractions.set_by_id(1).files[0].id

        response = client.post(
            "/console/sites/baseoil/reading/1/rows",
            data={
                "file_id": str(file_id), "filename": "lube.txt",
                "name": "Bit Bulk VG30", "price": "70060", "note": "BASIC", "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 303
        _, _, row, _ = extractions.inserted[0]
        assert row["note"] == "BASIC"


class TestACorrectionIsHeldToRealValues:
    def test_a_shape_valid_impossible_date_is_a_422_not_a_500(self):
        # "2026-02-31" matched the old YYYY-MM-DD pattern, reached the DATE
        # column, and psycopg raised -- a 500 that lost every other edit in
        # the row.
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1300", "price_date": "2026-02-31",
                "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []

    def test_a_thirteenth_month_is_a_422_too(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={
                "name": "FOB Asia SN 150", "price": "1300", "price_date": "2026-13-01",
                "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []

    def test_a_blank_name_is_refused_rather_than_silently_voiding_the_row(self):
        # name is TEXT NOT NULL and "" is legal, so the row stayed ticked,
        # reached the analysis as {"name": ""}, matched nothing, and the
        # price vanished from the draft with no message anywhere.
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "   ", "price": "1300", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert "needs a name" in response.text
        assert extractions.updated == []

    def test_nan_never_reaches_the_price_column(self):
        # float("nan") <= 0 is False, so nan walked past the positivity check.
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "nan", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []

    def test_a_zero_price_is_not_reported_as_not_a_number(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "0", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert "more than zero" in response.text
        assert "not a number" not in response.text


class TestAFailureSaysWhatItWas:
    """"No prices found in this report" was printed for a genuinely empty
    report, a length cap, a refusal and a safety stop alike."""

    def test_a_model_that_stopped_short_says_so_instead_of_reading_as_empty(self):
        class Capped(StubDriver):
            def generate(self, prompt):
                self.prompts.append(prompt)

                return AiCompletion(
                    status="length", text=None, prompt_tokens=1, completion_tokens=1,
                    error="The answer hit the length limit.",
                )

        client, extractions = build(Capped())

        response = upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        assert response.status_code == 303
        assert "err=" in response.headers["location"]

        page = client.get(response.headers["location"]).text
        assert "length limit" in page
        assert "was not read to the end" in page


class TestPicturesThatCouldNotBeRead:
    """Three ways the picture call fails, all of them silent until now. This
    is the USA-posted-prices case: the editor sees 40 plausible rows and the
    USA locations come back with no evidence two screens later."""

    @staticmethod
    def _with_pictures(monkeypatch):
        monkeypatch.setattr(
            "app.console.routes_reading.document_images",
            lambda filename, raw: [("image/png", b"not-really-a-png")],
        )

    def test_a_provider_that_cannot_see_says_so(self, monkeypatch):
        self._with_pictures(monkeypatch)
        # StubDriver has no generate_with_images at all.
        client, extractions = build()

        response = upload(client, [("lube.docx", b"FOB Asia SN 150 1260")])
        page = client.get(response.headers["location"]).text

        assert "vision-capable provider" in page

    def test_a_declined_transcription_surfaces_the_reason(self, monkeypatch):
        self._with_pictures(monkeypatch)

        class Blind(StubDriver):
            def generate_with_images(self, prompt, images):
                return AiCompletion(
                    status="declined", text=None, prompt_tokens=1, completion_tokens=1,
                    error="The model would not read the picture.",
                )

        client, extractions = build(Blind())

        response = upload(client, [("lube.docx", b"FOB Asia SN 150 1260")])
        page = client.get(response.headers["location"]).text

        assert "would not read the picture" in page

    def test_a_transcription_that_raises_surfaces_the_error(self, monkeypatch):
        self._with_pictures(monkeypatch)

        class Exploding(StubDriver):
            def generate_with_images(self, prompt, images):
                raise AiProviderError("the vision endpoint is down")

        client, extractions = build(Exploding())

        response = upload(client, [("lube.docx", b"FOB Asia SN 150 1260")])
        page = client.get(response.headers["location"]).text

        assert "the vision endpoint is down" in page

    def test_the_saved_instructions_ride_on_the_picture_call_too(self, monkeypatch):
        # "The USA prices are in the picture" is the literal placeholder on
        # the instructions box; a fixed prompt threw it away.
        self._with_pictures(monkeypatch)
        seen = {}

        class Seeing(StubDriver):
            def generate_with_images(self, prompt, images):
                seen["prompt"] = prompt

                return AiCompletion(
                    status="complete", text="USA posted prices 1500",
                    prompt_tokens=1, completion_tokens=1, error=None,
                )

        store = FakeStore(
            dataclasses.replace(
                SITE, editorial_instructions="The USA prices are in the picture."
            )
        )
        client, extractions = build(Seeing(), store=store)

        upload(client, [("lube.docx", b"FOB Asia SN 150 1260")])

        assert "The USA prices are in the picture." in seen["prompt"]


class TestAScannedPdfReachesTheReadingCall:
    """The HPCL circular the owner uploaded is a scan -- a page-sized JPEG
    with no text layer at all. document_to_text correctly returns "" for it,
    so its own picture has to be transcribed and that text has to reach the
    ordinary reading call -- if "no text, record as unreadable" ran before
    the transcription was appended, a scanned PDF would still die there and
    this whole feature would do nothing."""

    def test_a_text_free_pdf_reaches_the_reading_call_via_its_own_picture(self):
        from tests.test_editorial import _jpeg_bytes, build_pdf_with_images

        pdf = build_pdf_with_images([], [("/DCTDecode", _jpeg_bytes(40_000))])

        class Seeing(StubDriver):
            def generate_with_images(self, prompt, images):
                return AiCompletion(
                    status="complete", text="FOB Asia SN 150 1260",
                    prompt_tokens=1, completion_tokens=1, error=None,
                )

        client, extractions = build(Seeing(answers=[ANSWER]))

        response = upload(client, [("scan.pdf", pdf)])
        page = client.get(response.headers["location"]).text

        # It reached the ordinary reading call and got a row out of it --
        # the opposite of the "could not be read" panel a scan used to get.
        assert "could not be read" not in page
        assert extractions.added[0][0] == "scan.pdf"
        assert extractions.added[0][1][0]["name"] == "FOB Asia SN 150"

    def test_a_pdf_whose_picture_also_fails_still_reports_honestly(self):
        # No text and no usable picture: it must still land as the plain
        # "could not be read" failure, never a silent empty panel.
        from tests.test_editorial import _jpeg_bytes, build_pdf_with_images

        pdf = build_pdf_with_images([], [("/DCTDecode", _jpeg_bytes(40_000))])

        class Blind(StubDriver):
            def generate_with_images(self, prompt, images):
                return AiCompletion(
                    status="declined", text=None, prompt_tokens=1,
                    completion_tokens=1, error="The model would not read the picture.",
                )

        client, extractions = build(Blind())

        response = upload(client, [("scan.pdf", pdf)])
        page = client.get(response.headers["location"]).text

        assert "could not be read" in page
        assert extractions.added == [("scan.pdf", [])]


class TestTwoUploadsWithTheSameName:
    def test_they_are_two_panels_not_one(self):
        # Keyed on the filename, report.docx and report.docx merged into one
        # panel with both files' prices in it.
        client, extractions = build(StubDriver(answers=[ANSWER, ANSWER]))
        upload(
            client,
            [("report.docx", b"FOB Asia SN 150 1260"), ("report.docx", b"Izmir 81212")],
        )

        reading = extractions.set_by_id(1)
        assert [entry.filename for entry in reading.files] == ["report.docx", "report.docx"]

        page = client.get("/console/sites/baseoil/reading/1").text
        assert page.count("<h2>report.docx</h2>") == 2


class LegacyExtractions:
    """A reading taken before migration 0010: console_reading_files has its
    rows, and the price rows have no file_id at all."""

    def __init__(self):
        self.sets = {
            1: ReadingSet(
                id=1, site_slug="baseoil", created_by="editor@local.test", created_at=None,
                files=[ReadFile(id=11, filename="report.docx")],
            )
        }
        self.rows = [
            ReadRow(
                id=index, set_id=1, filename="report.docx", name=f"SN {index}",
                price=1000.0 + index, price_min=None, price_max=None, currency="USD",
                unit="MT", basis="FOB", price_date=None, note=None, kept=True, file_id=None,
            )
            for index in (1, 2)
        ]

    def set_by_id(self, set_id):
        return self.sets.get(set_id)

    def rows_for(self, set_id):
        return list(self.rows)


class TestAReadingFromBeforeTheFileColumnExisted:
    def test_its_rows_land_in_the_panel_their_file_already_made(self):
        # console_reading_files.id is never NULL, so a legacy row keyed by
        # ("name", filename) matched nothing and made a SECOND panel: the
        # file drawn once empty, saying "No prices found in this report",
        # directly above the same file with its twelve prices in it.
        client, _ = build(extractions=LegacyExtractions())

        page = client.get("/console/sites/baseoil/reading/1").text

        assert page.count("<h2>report.docx</h2>") == 1
        assert "No prices found in this report" not in page
        assert "2 prices read" in page
        assert "SN 1" in page and "SN 2" in page

    def test_two_uploads_of_the_same_name_are_still_two_panels(self):
        # The fix must not undo the one before it: a filename index that
        # swallowed real file rows would merge them again.
        client, extractions = build(StubDriver(answers=[ANSWER, ANSWER]))
        upload(
            client,
            [("report.docx", b"FOB Asia SN 150 1260"), ("report.docx", b"Izmir 81212")],
        )

        page = client.get("/console/sites/baseoil/reading/1").text

        assert page.count("<h2>report.docx</h2>") == 2


class TestTheCheckScreenUsesTheFullWidth:
    """The table is squeezed into the console's shared 72rem content column,
    and Name and Basis -- the two longest values, and the two that tell an
    otherwise-identical row apart -- get truncated worst. This screen alone
    opts into the full window; nothing else does."""

    def test_the_content_pane_opts_into_the_wide_class(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert 'class="content wide"' in page

    def test_no_other_console_template_opts_into_wide(self):
        # base.html defines the {% block content_class %} every screen can
        # fill in; reading.html is the only one that should.
        import pathlib

        templates_dir = pathlib.Path("app/templates")
        others = [
            path for path in templates_dir.glob("*.html")
            if path.name not in ("reading.html", "base.html")
        ]

        assert others, "expected other console templates to check"

        for path in others:
            assert "content_class" not in path.read_text(encoding="utf-8"), path

    def test_name_and_basis_are_the_two_widest_columns(self):
        answer = json.dumps(
            [
                {
                    "name": "HP Tuffbit Bitumen VG 40 (Bulk) Ex-Hincol Vashi",
                    "price": 70060,
                    "currency": "INR",
                    "unit": "MT",
                    "basis": "Ex Koyali Installation / Baroda Bitumen COD",
                }
            ]
        )
        client, extractions = build(StubDriver(answers=[answer]))
        upload(client, [("hpcl.txt", b"HP Tuffbit VG40 70060 Koyali")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert "<colgroup>" in page
        # The two widest <col> shares in the group belong to Name and Basis
        # (columns 2 and 8 of the header row: No., Name, Price, Min, Max,
        # Currency, Unit, Basis, Date, Note, Use this, blank).
        widths = [int(pct) for pct in re.findall(r'width:(\d+)%', page.split("<colgroup>")[1].split("</colgroup>")[0])]
        assert len(widths) == 12
        name_width, basis_width = widths[1], widths[7]
        others = widths[:1] + widths[2:7] + widths[8:]
        assert all(name_width > other for other in others)
        assert all(basis_width > other for other in others)

    def test_the_row_inputs_grow_with_their_column_rather_than_a_fixed_size(self):
        answer = json.dumps(
            [
                {
                    "name": "Bit Bulk VG30", "price": 70060, "currency": "INR",
                    "basis": "Ex Mumbai Refinery",
                }
            ]
        )
        client, extractions = build(StubDriver(answers=[answer]))
        upload(client, [("bpcl.txt", b"Bit Bulk VG30 70060 Ex Mumbai Refinery")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert 'name="name" value="Bit Bulk VG30" style="width:100%"' in page
        assert 'name="basis" value="Ex Mumbai Refinery" style="width:100%"' in page
        assert 'name="currency" value="INR" style="width:100%"' in page

    def test_the_table_scrolls_inside_its_own_panel_not_the_page(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        page = client.get("/console/sites/baseoil/reading/1").text

        # .panel's own overflow-x:auto (defined once in base.html) is the
        # scroll container; the table declares a bounded min-width rather
        # than forcing the page body itself to scroll sideways.
        assert "overflow-x:auto" in page
        match = re.search(r'<table class="reading-table" style="[^"]*min-width:(\d+(?:\.\d+)?)rem', page)
        assert match, page
        # Well short of a laptop's own width so the page never forces a
        # wider-than-the-screen layout.
        assert float(match.group(1)) <= 70

    def test_every_existing_control_survives_the_layout_change(self):
        answer = json.dumps([{"name": "Bit Bulk VG30", "price": 70060, "note": "BASIC"}])
        client, extractions = build(StubDriver(answers=[answer]))
        response = upload(
            client, [("bpcl.txt", b"Bit Bulk VG30 70060 BASIC")], pricedate="2026-09-01"
        )

        page = client.get(response.headers["location"]).text

        assert "Save" in page
        assert 'name="kept" value="1"' in page
        assert "Add a price from this report" in page
        assert 'type="hidden" name="pricedate" value="2026-09-01"' in page
        assert "<th>Note</th>" in page

        # The owner's vocabulary only, and only within this screen's own
        # body content -- base.html's shared <style> carries an unrelated
        # code comment mentioning "rulebook" for the Price rules screen,
        # which is not this screen's concern and not something a person
        # reads here, and the <title> can repeat the h1's own words.
        body = page.split("</style>", 1)[1]
        content = body.split("Check what was read", 1)[1]
        for forbidden in ("extraction", "parsed", "derived", "rulebook"):
            assert forbidden not in content.lower()


class TestAddingAPriceTheModelMissed:
    """The spec's fourth verb: "change a figure, fix a name, drop a row, or
    add one the model missed". Seeing a skipped table and still not being
    able to type its prices is the measured failure only half fixed."""

    def test_the_form_is_on_every_file_panel(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert 'action="/console/sites/baseoil/reading/1/rows"' in page
        assert "Add a price from this report" in page

    def test_a_typed_price_is_kept_under_that_file(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])
        file_id = extractions.set_by_id(1).files[0].id

        response = client.post(
            "/console/sites/baseoil/reading/1/rows",
            data={
                "file_id": str(file_id), "filename": "lube.txt",
                "name": "Ex-tank Singapore SN 500", "price": "1480",
                "price_min": "1460", "price_max": "1500", "currency": "usd",
                "unit": "MT", "basis": "ex-tank", "price_date": "2026-08-19", "kept": "1",
            },
            follow_redirects=False,
        )

        assert response.status_code == 303
        set_id, filename, row, stored_file_id = extractions.inserted[0]
        assert (set_id, filename, stored_file_id) == (1, "lube.txt", file_id)
        assert row["name"] == "Ex-tank Singapore SN 500"
        assert (row["price"], row["price_min"], row["price_max"]) == (1480.0, 1460.0, 1500.0)
        assert row["price_date"] == "2026-08-19"
        assert row["kept"] is True

        page = client.get("/console/sites/baseoil/reading/1").text
        assert "Ex-tank Singapore SN 500" in page

    def test_a_typed_row_is_held_to_the_same_rules_as_a_correction(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])
        file_id = extractions.set_by_id(1).files[0].id

        for bad in (
            {"name": "", "price": "1480"},
            {"name": "SN 500", "price": "-5"},
            {"name": "SN 500", "price": "about 1480"},
            {"name": "SN 500", "price": "1480", "price_date": "2026-02-31"},
        ):
            response = client.post(
                "/console/sites/baseoil/reading/1/rows",
                data={"file_id": str(file_id), "filename": "lube.txt", **bad},
                follow_redirects=False,
            )

            assert response.status_code == 422, bad
            assert extractions.inserted == []

    def test_a_price_cannot_be_added_to_a_file_of_another_reading(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows",
            data={"file_id": "999", "filename": "somebody-elses.txt",
                  "name": "SN 500", "price": "1480"},
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.inserted == []


class TestTheRowsAreNumbered:
    """The client asked for it: a long list is counted off against the report,
    not scrolled through twice."""

    def test_each_read_row_carries_its_number(self):
        answer = json.dumps(
            [
                {"name": "Bit Bulk VG10", "price": 69100, "currency": "INR"},
                {"name": "Bit Bulk VG30", "price": 70060, "currency": "INR"},
                {"name": "Bit Bulk VG40", "price": 75100, "currency": "INR"},
            ]
        )
        client, _ = build(StubDriver(answers=[answer]))
        upload(client, [("bpcl.txt", b"three prices")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert "&#8470;" in page or "No." in page

        body = page.split("<tbody>")[1].split("</tbody>")[0]

        for number in ("1", "2", "3"):
            assert f">{number}</td>" in body

    def test_the_numbering_starts_again_for_each_report(self):
        answer = json.dumps([{"name": "A", "price": 10}])
        client, _ = build(StubDriver(answers=[answer, answer]))
        upload(client, [("one.txt", b"a"), ("two.txt", b"b")])

        page = client.get("/console/sites/baseoil/reading/1").text

        # Two panels, each starting at 1 -- a number is a position within its
        # own report, which is what makes it checkable against that report.
        assert page.count(">1</td>") == 2


class TestPicturesOfATextReportAreReadOnTheirOwn:
    """11 Sep 2026 Argus: page 6's lira column is drawn, so the page went to
    the vision model, which transcribed "Turkey 29,084 29,084 nc 600 600"
    perfectly -- and then, pasted after ~15,000 tokens of report, the same
    model skipped it on one run in two. The pictures now get their own call."""

    TABLE = "Turkey | 29,084 | 29,084 | nc | 600 | 600 | -2.00"
    TURKEY = (
        '[{"name": "Turkey", "price": 29084, "currency": "TRY", '
        '"basis": "ex-works", "note": "Local currency/t"}]'
    )

    def _driver(self):
        table = self.TABLE

        class Seeing(StubDriver):
            def generate_with_images(self, prompt, images):
                return AiCompletion(
                    status="complete", text=table, prompt_tokens=1, completion_tokens=1,
                    error=None,
                )

        return Seeing(answers=[ANSWER, self.TURKEY])

    def test_the_report_and_its_pictures_are_two_reading_calls(self, monkeypatch):
        monkeypatch.setattr(
            "app.console.routes_reading.document_images",
            lambda filename, raw: [("image/png", b"page-6")],
        )
        driver = self._driver()
        client, extractions = build(driver)

        upload(client, [("argus.txt", b"FOB Asia SN 150 1260")])

        report_prompt, pictures_prompt = driver.prompts
        assert "FOB Asia SN 150 1260" in report_prompt
        assert self.TABLE not in report_prompt
        assert self.TABLE in pictures_prompt
        assert "FOB Asia SN 150 1260" not in pictures_prompt

    def test_both_sets_of_rows_land_under_the_one_file(self, monkeypatch):
        monkeypatch.setattr(
            "app.console.routes_reading.document_images",
            lambda filename, raw: [("image/png", b"page-6")],
        )
        client, extractions = build(self._driver())

        upload(client, [("argus.txt", b"FOB Asia SN 150 1260")])

        [(filename, rows)] = extractions.added
        assert filename == "argus.txt"
        assert [row["name"] for row in rows] == ["FOB Asia SN 150", "Turkey"]
        turkey = rows[1]
        assert turkey["currency"] == "TRY"
        assert turkey["note"] == "Local currency/t; read from a picture of the page"

    def test_a_failed_pictures_reading_keeps_the_reports_rows(self, monkeypatch):
        monkeypatch.setattr(
            "app.console.routes_reading.document_images",
            lambda filename, raw: [("image/png", b"page-6")],
        )
        table = self.TABLE

        class HalfBroken(StubDriver):
            def generate_with_images(self, prompt, images):
                return AiCompletion(
                    status="complete", text=table, prompt_tokens=1, completion_tokens=1,
                    error=None,
                )

            def generate(self, prompt):
                if table in prompt:
                    raise RuntimeError("timed out")

                return super().generate(prompt)

        client, extractions = build(HalfBroken())

        response = upload(client, [("argus.txt", b"FOB Asia SN 150 1260")])
        page = client.get(response.headers["location"]).text

        assert [row["name"] for row in extractions.added[0][1]] == ["FOB Asia SN 150"]
        assert "the figures in its pictures were not read" in page


class TestALongReportIsReadInSections:
    """One call for a 19-page report returns the first few pages and stops
    (15 Oct 2026: 60 rows, all from pages 3-5, two thirds of the issue
    missing). Each section now gets its own reading, the way the page
    pictures already do.
    """

    def long_report(self) -> bytes:
        page = "Somewhere 100 110 nc 120 130 -1.00\n" * 40
        body = "".join(
            f"Issue 26-39 | Friday 25 September 2026 Page {n} of 19\n{page}"
            for n in range(1, 20)
        )

        return body.encode("utf-8")

    def test_each_section_is_its_own_call_carrying_only_its_own_text(self):
        driver = StubDriver()
        client, _ = build(driver=driver)

        upload(client, [("argus.txt", self.long_report())])

        assert len(driver.prompts) > 1
        # Every page of the report reached exactly one of the calls.
        for number in range(1, 20):
            footer = f"Page {number} of 19"
            assert sum(1 for prompt in driver.prompts if footer in prompt) == 1

    def test_every_section_says_which_part_it_is(self):
        # The model is told what it is holding; the editor sees it in any
        # failure message, which is otherwise "argus.txt" five times.
        driver = StubDriver()
        client, _ = build(driver=driver)

        upload(client, [("argus.txt", self.long_report())])

        assert all("argus.txt (part " in prompt for prompt in driver.prompts)

    def test_the_rows_of_every_section_are_kept_together(self):
        rows = [
            json.dumps([{"name": f"Place {n}", "price": 100 + n, "currency": "USD"}])
            for n in range(1, 9)
        ]
        driver = StubDriver(answers=rows)
        client, extractions = build(driver=driver)

        upload(client, [("argus.txt", self.long_report())])

        found = {row["name"] for _, rows in extractions.added for row in rows}
        assert len(found) == len(driver.prompts)

    def test_one_section_failing_costs_that_section_only(self):
        class HalfBrokenDriver(StubDriver):
            def generate(self, prompt):
                if "part 2 of" in prompt:
                    raise AiProviderError("the model timed out")

                return super().generate(prompt)

        client, extractions = build(driver=HalfBrokenDriver())

        response = upload(client, [("argus.txt", self.long_report())])
        kept = [row for _, rows in extractions.added for row in rows]

        assert kept, "one bad section threw away every other section's prices"
        # The editor is told which part was lost, not just that something was.
        assert "part 2 of" in unquote_plus(response.headers["location"])

    def test_a_short_report_is_still_a_single_call(self):
        driver = StubDriver()
        client, _ = build(driver=driver)

        upload(client, [("small.txt", b"Singapore 798 809 nc\n")])

        assert len(driver.prompts) == 1
        assert "(part " not in driver.prompts[0]


class TestTheEditorChoosesWhetherTheInstructionsApply:
    """The saved rulebook used to ride along silently on every upload.

    Four rounds of mismatch files in October 2026 turned on what the model
    was or was not told, and afterwards nobody could say which instructions
    had been in force for a given run -- there was no record and no moment
    where anyone had looked at them. The upload form now shows them and
    carries an explicit tick, so an editor sees the rulebook before it is
    sent and can leave it out of a run.
    """

    INSTRUCTED = "Japan FOB - give the DOLLAR Low and the High exactly as printed."

    def store(self):
        store = FakeStore()
        store.site = dataclasses.replace(store.site, editorial_instructions=self.INSTRUCTED)

        return store

    def upload_with(self, driver, **extra):
        client, _ = build(driver, store=self.store())

        return client.post(
            "/console/sites/baseoil/reading",
            files=[("documents", ("r.txt", io.BytesIO(b"FOB Asia SN 150 1260"), "text/plain"))],
            data={"pricedate": "2026-10-16", **extra},
            follow_redirects=False,
        )

    def test_a_ticked_box_sends_the_saved_instructions(self):
        driver = StubDriver()
        self.upload_with(driver, use_instructions="on")

        assert any(self.INSTRUCTED in prompt for prompt in driver.prompts)

    def test_an_absent_box_leaves_them_out(self):
        # An unticked checkbox posts nothing at all, which is the whole point
        # of asking: the rulebook rides along only when someone says so.
        driver = StubDriver()
        self.upload_with(driver)

        assert not any(self.INSTRUCTED in prompt for prompt in driver.prompts)

    def test_the_editor_can_send_an_edited_version_for_this_run_only(self):
        driver = StubDriver()
        self.upload_with(
            driver, use_instructions="on", instructions="Japan FOB - read the YEN column."
        )

        assert any("read the YEN column" in prompt for prompt in driver.prompts)
        assert not any(self.INSTRUCTED in prompt for prompt in driver.prompts)

    def test_an_edit_for_one_run_does_not_overwrite_what_is_saved(self):
        store = self.store()
        client, _ = build(StubDriver(), store=store)

        client.post(
            "/console/sites/baseoil/reading",
            files=[("documents", ("r.txt", io.BytesIO(b"x"), "text/plain"))],
            data={"use_instructions": "on", "instructions": "just for today"},
            follow_redirects=False,
        )

        assert store.site.editorial_instructions == self.INSTRUCTED
