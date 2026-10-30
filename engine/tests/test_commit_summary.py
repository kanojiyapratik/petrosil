"""Committing a batch also writes the note that goes on the site's front end.

The rule these tests exist to hold: the note is a courtesy, the commit is the
job. Nothing that goes wrong while writing or posting a note may make a
successful publish look like a failure to the person who clicked the button.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.providers import AiCompletion, AiProviderError, declined
from app.console.routes_prices import create_price_routes
from app.console.site_client import SiteError
from app.db.store import StoredSite

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
)

BATCH = {
    "batch": {"id": 12, "source": "crawl"},
    "items": [
        {
            "location": "Singapore N 150 FOB Group II",
            "old_price": 905.0, "new_price": 880.0, "delta_pct": -2.76,
            "is_included": True, "status": "ok",
        },
    ],
}

NOTE = "Group II grades in Singapore eased this week while Europe held flat."


class FakeStore:
    def __init__(self):
        self.records = []

    def site_by_slug(self, slug):
        return SITE if slug == SITE.slug else None

    def record(self, user_email, action, site_slug=None, detail=None):
        self.records.append(action)


class FakeSiteClient:
    def __init__(self, commit_result=None, batch=None, summary_raises=None):
        self._commit_result = commit_result or {"committed": 1}
        self._batch = batch if batch is not None else BATCH
        self._summary_raises = summary_raises
        self.summaries = []

    def commit_batch(self, batch_id):
        return self._commit_result

    def batch(self, batch_id):
        return self._batch

    def post_summary(self, summary, source, batch_id=None):
        if self._summary_raises:
            raise self._summary_raises

        self.summaries.append({"summary": summary, "source": source, "batch_id": batch_id})

        return {"id": 1}


class StubDriver:
    def __init__(self, completion=None, raises=None):
        self._completion = completion or AiCompletion(
            status="complete", text=NOTE, prompt_tokens=1, completion_tokens=1, error=None,
        )
        self._raises = raises
        self.calls = []

    def generate(self, model, prompt):
        self.calls.append(prompt)

        if self._raises:
            raise self._raises

        return self._completion


def commit(site_client, driver):
    app = FastAPI()
    app.include_router(
        create_price_routes(
            store=FakeStore(),
            templates=None,
            current_user=lambda request: type("U", (), {"email": "admin@local.test", "is_admin": True, "is_superadmin": True})(),
            client_factory=lambda site: site_client,
            driver=driver,
            default_model="gpt-4o-mini",
        )
    )
    client = TestClient(app)

    return client.post("/console/sites/baseoil/prices/12/commit", follow_redirects=False)


class TestTheNoteIsWrittenOnCommit:
    def test_the_committed_batch_becomes_a_note_on_the_site(self):
        site_client = FakeSiteClient()

        response = commit(site_client, StubDriver())

        assert response.status_code == 303
        assert site_client.summaries == [
            {"summary": NOTE, "source": "crawl", "batch_id": 12}
        ]

    def test_the_note_is_written_from_movements_and_never_from_a_price(self):
        driver = StubDriver()

        commit(FakeSiteClient(), driver)

        assert "905" not in driver.calls[0]
        assert "880" not in driver.calls[0]


class TestNothingAboutTheNoteCanBreakAPublish:
    def test_a_model_failure_still_leaves_the_publish_successful(self):
        site_client = FakeSiteClient()

        response = commit(site_client, StubDriver(raises=AiProviderError("no key")))

        assert response.status_code == 303
        assert "ok=" in response.headers["location"]
        assert site_client.summaries == []

    def test_a_declining_model_posts_no_note(self):
        site_client = FakeSiteClient()

        commit(site_client, StubDriver(completion=declined("blocked")))

        assert site_client.summaries == []

    def test_the_site_refusing_the_note_still_leaves_the_publish_successful(self):
        site_client = FakeSiteClient(summary_raises=SiteError("no such endpoint", 404))

        response = commit(site_client, StubDriver())

        assert response.status_code == 303
        assert "ok=" in response.headers["location"]

    def test_a_batch_that_cannot_be_read_back_still_leaves_the_publish_successful(self):
        class Unreadable(FakeSiteClient):
            def batch(self, batch_id):
                raise SiteError("gone", 500)

        response = commit(Unreadable(), StubDriver())

        assert response.status_code == 303
        assert "ok=" in response.headers["location"]
