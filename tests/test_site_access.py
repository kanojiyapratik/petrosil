"""Who may use which website.

The console used to show every enabled site to everyone who could sign in.
Now an ordinary user sees only the sites the superadmin has given them, and
the whole feature is one check: a dozen screens resolve a site from a slug
anyone can type into the address bar, and three list sites. These tests pin
the security properties rather than the happy path -- one 404 per guard, so a
guard added later without the check is caught here rather than in production.

Nothing here asserts a 403. A 403 would tell someone that the site they just
guessed at does exist, which is the one thing a missing grant is meant to
keep quiet about: an ungranted site answers exactly what a hidden one does.
"""

import pytest

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.console.auth import SESSION_COOKIE, new_session, sign_session
from app.console.routes import create_console
from app.console.routes_ai import create_ai_routes
from app.console.routes_editorial import create_editorial_routes
from app.console.routes_prices import create_price_routes
from app.console.routes_reading import create_reading_routes
from app.console.routes_rules import create_rules_routes
from app.db.migrate import MIGRATIONS
from app.db.store import StoredSite, StoredUser, seed

SECRET = "s" * 40
TEMPLATES = Jinja2Templates(directory="app/templates")

SUPER = StoredUser(
    id=1, email="superadmin@petrocil.in", name="Super", password_hash="x",
    is_admin=True, disabled_at=None, is_superadmin=True,
)
RAKESH = StoredUser(
    id=2, email="rakesh@tikitech.in", name="Rakesh", password_hash="x",
    is_admin=True, disabled_at=None, is_superadmin=False,
)
EDITOR = StoredUser(
    id=3, email="editor@tikitech.in", name="Editor", password_hash="x",
    is_admin=False, disabled_at=None, is_superadmin=False,
)

BASEOIL = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://baseoil.test/api", token="t", enabled=True,
)
WAX = StoredSite(
    db_id=2, slug="waxreport", name="Wax Report",
    api_url="https://wax.test/api", token="t", enabled=True,
)
HIDDEN = StoredSite(
    db_id=3, slug="bitumen", name="Bitumen Report",
    api_url="https://bitumen.test/api", token="t", enabled=False,
)


class FakeStore:
    def __init__(self, grants=None, sites=None, users=None):
        self._users = list(users if users is not None else [SUPER, RAKESH, EDITOR])
        self._sites = list(sites if sites is not None else [BASEOIL, WAX, HIDDEN])
        self.grants = {user_id: set(slugs) for user_id, slugs in (grants or {}).items()}
        self.records = []

    # users
    def users(self):
        return list(self._users)

    def active_users(self):
        return [row for row in self._users if row.disabled_at is None]

    # sites
    def sites(self):
        return list(self._sites)

    def enabled_sites(self):
        return [row for row in self._sites if row.enabled]

    def site_by_slug(self, slug):
        return next((row for row in self._sites if row.slug == slug), None)

    def set_site_enabled(self, slug, enabled):
        return self.site_by_slug(slug)

    def upsert_site(self, slug, name, api_url, api_token, enabled):
        self._sites.append(
            StoredSite(db_id=99, slug=slug, name=name, api_url=api_url,
                       token=api_token, enabled=enabled)
        )

        return self._sites[-1]

    # grants
    def granted_slugs(self, user_id):
        return set(self.grants.get(user_id, set()))

    def all_grants(self):
        return {user_id: set(slugs) for user_id, slugs in self.grants.items()}

    def grant_site(self, user_id, slug, granted_by):
        self.grants.setdefault(user_id, set()).add(slug)

    def revoke_site(self, user_id, slug):
        self.grants.get(user_id, set()).discard(slug)

    # the rest
    def record(self, user_email, action, site_slug=None, detail=None):
        self.records.append((user_email, action, site_slug, detail))

    def audit(self, limit=100, site_slug=None):
        return []


class FakeSiteClient:
    def batches(self):
        return {"data": []}

    def locations(self):
        return {"data": []}

    def watched_urls(self):
        return {"data": [], "interval_minutes": 15, "instructions": None}

    def activity(self, limit=50):
        return {"data": []}


class FakeRules:
    def for_site(self, slug):
        return []


class FakeRounding:
    def for_site(self, slug):
        return {}

    def list_for_site(self, slug):
        return []


class FakeExtractions:
    def latest_open(self, slug):
        return None

    def latest_used(self, slug):
        return None

    def set_by_id(self, set_id):
        return None


class FakeProviders:
    def all(self):
        return []

    def assignments(self):
        return {}


def console_client(store, signed_in_as):
    """The main console router, reached the way a browser reaches it: with a
    signed session cookie, so signing in is part of what is tested."""
    app = FastAPI()
    app.include_router(
        create_console(
            store=store, secret=SECRET, templates=TEMPLATES,
            secure_cookies=False, client_factory=lambda site: FakeSiteClient(),
        )
    )
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE, sign_session(new_session(signed_in_as.email), SECRET))

    return client


def router_client(factory, store, user, **extra):
    app = FastAPI()
    app.include_router(
        factory(store=store, templates=TEMPLATES, current_user=lambda request: user, **extra)
    )

    return TestClient(app)


def prices_client(store, user):
    return router_client(create_price_routes, store, user,
                         client_factory=lambda site: FakeSiteClient())


def rules_client(store, user):
    return router_client(create_rules_routes, store, user, rules=FakeRules(),
                         rounding=FakeRounding(),
                         client_factory=lambda site: FakeSiteClient())


def editorial_client(store, user):
    return router_client(create_editorial_routes, store, user, driver=None,
                         default_model="m", extractions=FakeExtractions(),
                         rules=FakeRules(), rounding=FakeRounding(),
                         client_factory=lambda site: FakeSiteClient())


def reading_client(store, user):
    return router_client(create_reading_routes, store, user, driver=None,
                         default_model="m", extractions=FakeExtractions())


def ai_client(store, user):
    app = FastAPI()
    app.include_router(
        create_ai_routes(store=store, providers=FakeProviders(), templates=TEMPLATES,
                         current_user=lambda request: user)
    )

    return TestClient(app)


# One address per guard. A guard added later without the access check shows up
# as a missing entry here, which is why they are listed rather than tested one
# screen at a time.
GUARDS = [
    ("the console's own screens", console_client, "/console/sites/waxreport"),
    ("the crawler screen", console_client, "/console/sites/waxreport/crawler"),
    ("the price screens", prices_client, "/console/sites/waxreport/prices"),
    ("the rules screen", rules_client, "/console/sites/waxreport/rules"),
    ("the editorial screen", editorial_client, "/console/sites/waxreport/editorial"),
    ("the reading screens", reading_client, "/console/sites/waxreport/reading/1"),
]

GUARD_IDS = [row[0] for row in GUARDS]


def open_as(build, store, user, path):
    return build(store, user).get(path, follow_redirects=False)


class TestASiteNobodyGaveYou:
    @pytest.mark.parametrize("name,build,path", GUARDS, ids=GUARD_IDS)
    def test_answers_404_and_never_403(self, name, build, path):
        # Rakesh has baseoil and not waxreport.
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = open_as(build, store, RAKESH, path)

        assert response.status_code == 404
        assert "No such site" in response.text

    @pytest.mark.parametrize("name,build,path", GUARDS, ids=GUARD_IDS)
    def test_reads_exactly_as_a_site_that_does_not_exist(self, name, build, path):
        """The refusal must not be distinguishable from a missing site."""
        granted = FakeStore(grants={RAKESH.id: {"baseoil"}})
        missing = FakeStore(grants={RAKESH.id: {"baseoil", "waxreport"}},
                            sites=[BASEOIL, HIDDEN])

        ungranted = open_as(build, granted, RAKESH, path)
        absent = open_as(build, missing, RAKESH, path)

        assert ungranted.status_code == absent.status_code
        assert ungranted.text == absent.text


class TestASiteYouWereGiven:
    @pytest.mark.parametrize("name,build,path", GUARDS, ids=GUARD_IDS)
    def test_is_not_the_no_such_site_page(self, name, build, path):
        store = FakeStore(grants={RAKESH.id: {"baseoil", "waxreport"}})

        response = open_as(build, store, RAKESH, path)

        assert "That site is not configured" not in response.text

    @pytest.mark.parametrize("name,build,path", GUARDS, ids=GUARD_IDS)
    def test_the_superadmin_needs_no_grant_at_all(self, name, build, path):
        store = FakeStore(grants={})

        response = open_as(build, store, SUPER, path)

        assert "That site is not configured" not in response.text

    def test_taking_it_away_takes_effect_on_the_next_screen(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil", "waxreport"}})
        client = console_client(store, RAKESH)

        assert client.get("/console/sites/waxreport").status_code == 200

        store.revoke_site(RAKESH.id, "waxreport")

        assert client.get("/console/sites/waxreport").status_code == 404


class TestTheThreeListings:
    def test_the_site_list_shows_only_what_you_were_given(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        page = console_client(store, RAKESH).get("/console").text

        assert "Base Oil Report" in page
        assert "Wax Report" not in page

    def test_settings_sites_shows_only_what_you_were_given(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        page = console_client(store, RAKESH).get("/console/settings/sites").text

        assert "Base Oil Report" in page
        assert "Wax Report" not in page

    def test_the_ai_screen_shows_only_what_you_were_given(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        page = ai_client(store, RAKESH).get("/console/settings/ai").text

        assert "Base Oil Report" in page
        assert "Wax Report" not in page

    def test_the_superadmin_sees_every_site_in_all_three(self):
        store = FakeStore(grants={})
        console = console_client(store, SUPER)

        assert "Wax Report" in console.get("/console").text
        assert "Wax Report" in console.get("/console/settings/sites").text
        assert "Wax Report" in ai_client(store, SUPER).get("/console/settings/ai").text

    def test_a_hidden_site_is_still_absent_from_the_site_list(self):
        # The switch that was already there keeps working: a grant does not
        # override it.
        store = FakeStore(grants={RAKESH.id: {"baseoil", "bitumen"}})

        assert "Bitumen Report" not in console_client(store, RAKESH).get("/console").text


class TestWhatOnlyTheSuperadminMayDo:
    def test_an_ordinary_admin_cannot_open_the_access_screen(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = console_client(store, RAKESH).get("/console/settings/access")

        assert response.status_code == 403

    def test_the_superadmin_can(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = console_client(store, SUPER).get("/console/settings/access")

        assert response.status_code == 200
        assert "rakesh@tikitech.in" in response.text

    def test_the_superadmin_is_not_listed_as_someone_to_give_sites_to(self):
        store = FakeStore(grants={})

        page = console_client(store, SUPER).get("/console/settings/access").text

        assert "superadmin@petrocil.in" not in page

    def test_an_ordinary_admin_is_not_shown_the_add_a_site_form(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        page = console_client(store, RAKESH).get("/console/settings/sites").text

        assert "Add or update a site" not in page
        # The switch they are meant to have stays.
        assert "Hide" in page

    def test_the_superadmin_is_shown_it(self):
        page = console_client(FakeStore(), SUPER).get("/console/settings/sites").text

        assert "Add or update a site" in page

    def test_an_ordinary_admin_posting_the_add_a_site_form_is_refused(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = console_client(store, RAKESH).post(
            "/console/settings/sites",
            data={"slug": "newsite", "name": "New", "api_url": "https://new.test/api",
                  "api_token": "tok", "enabled": "on"},
            follow_redirects=False,
        )

        assert response.status_code == 403
        assert store.site_by_slug("newsite") is None

    def test_an_ordinary_admin_cannot_give_themselves_a_site(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = console_client(store, RAKESH).post(
            f"/console/settings/access/{RAKESH.id}",
            data={"sites": ["baseoil", "waxreport"]},
            follow_redirects=False,
        )

        assert response.status_code == 403
        assert store.granted_slugs(RAKESH.id) == {"baseoil"}


class TestGivingAndTakingAway:
    def test_saving_the_form_gives_what_was_ticked(self):
        store = FakeStore(grants={EDITOR.id: {"baseoil"}})

        console_client(store, SUPER).post(
            f"/console/settings/access/{EDITOR.id}",
            data={"sites": ["baseoil", "waxreport"]},
            follow_redirects=False,
        )

        assert store.granted_slugs(EDITOR.id) == {"baseoil", "waxreport"}

    def test_unticking_takes_it_away(self):
        store = FakeStore(grants={EDITOR.id: {"baseoil", "waxreport"}})

        console_client(store, SUPER).post(
            f"/console/settings/access/{EDITOR.id}",
            data={"sites": ["baseoil"]},
            follow_redirects=False,
        )

        assert store.granted_slugs(EDITOR.id) == {"baseoil"}

    def test_every_change_reaches_the_trail(self):
        store = FakeStore(grants={EDITOR.id: {"baseoil"}})

        console_client(store, SUPER).post(
            f"/console/settings/access/{EDITOR.id}",
            data={"sites": ["waxreport"]},
            follow_redirects=False,
        )

        actions = [(row[1], row[2]) for row in store.records]

        assert ("gave a user a website", "waxreport") in actions
        assert ("took a website away from a user", "baseoil") in actions

    def test_a_slug_that_is_not_a_site_is_ignored(self):
        store = FakeStore(grants={})

        console_client(store, SUPER).post(
            f"/console/settings/access/{EDITOR.id}",
            data={"sites": ["baseoil", "../etc"]},
            follow_redirects=False,
        )

        assert store.granted_slugs(EDITOR.id) == {"baseoil"}

    def test_the_superadmin_is_given_no_rows(self):
        """Two sources of truth for the same answer would only drift apart."""
        store = FakeStore(grants={})

        console_client(store, SUPER).post(
            f"/console/settings/access/{SUPER.id}",
            data={"sites": ["baseoil"]},
            follow_redirects=False,
        )

        assert store.granted_slugs(SUPER.id) == set()


class TestTheMigration:
    def test_it_is_appended_and_last(self):
        ids = [row.id for row in MIGRATIONS]

        assert ids[-1] == "0012_site_access"
        assert ids[-2] == "0011_price_rounding"
        assert len(ids) == len(set(ids))

    def test_it_leaves_everyone_the_access_they_already_had(self):
        sql = " ".join(
            next(row for row in MIGRATIONS if row.id == "0012_site_access").sql.split()
        )

        # Every existing user, crossed with every existing site.
        assert "INSERT INTO console_site_access" in sql
        assert "CROSS JOIN console_sites s" in sql
        assert "WHERE NOT u.is_superadmin" in sql

    def test_it_does_not_repurpose_is_admin(self):
        sql = next(row for row in MIGRATIONS if row.id == "0012_site_access").sql

        assert "DROP COLUMN is_admin" not in sql
        assert "RENAME COLUMN is_admin" not in sql

    def test_a_user_holding_every_site_sees_exactly_what_they_saw_before(self):
        """What the back-fill leaves behind: the change is invisible."""
        store = FakeStore(grants={RAKESH.id: {"baseoil", "waxreport", "bitumen"}})
        client = console_client(store, RAKESH)

        page = client.get("/console").text

        assert "Base Oil Report" in page and "Wax Report" in page
        assert client.get("/console/sites/waxreport").status_code == 200


class TestSeedingAFreshInstall:
    def test_a_newly_seeded_account_is_given_every_site(self):
        """The accounts seeded from the environment could use every site
        before the grants table existed; a fresh install must not start
        locked out of everything."""
        store = FakeStore(grants={}, users=[], sites=[])
        store.ensure_superadmin = lambda email=None: None
        store.create_user = lambda email, name, password_hash, is_admin: store._users.append(
            StoredUser(id=7, email=email, name=name, password_hash=password_hash,
                       is_admin=is_admin, disabled_at=None, is_superadmin=False)
        )

        seed(
            store,
            [{"email": "new@tikitech.in", "name": "New", "password_hash": "h"}],
            [{"slug": "baseoil", "name": "Base Oil Report",
              "api_url": "https://baseoil.test/api", "token": "t"}],
        )

        assert store.granted_slugs(7) == {"baseoil"}
