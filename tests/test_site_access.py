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

import dataclasses
import re

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
from app.db.store import RoundingStore, RulesStore, StoredSite, StoredUser, seed

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
        self.passwords_set = []
        self.disabled_set = []

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

    def set_user_password(self, user_id, password_hash):
        self.passwords_set.append(user_id)

    def set_user_disabled(self, user_id, disabled):
        self.disabled_set.append((user_id, disabled))


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


def rules_client(store, user, rules=None, rounding=None):
    return router_client(create_rules_routes, store, user,
                         rules=rules if rules is not None else FakeRules(),
                         rounding=rounding if rounding is not None else FakeRounding(),
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


def whole_console(store, user):
    """Every router the module mounts, on one app, so the routes can be asked
    what they are rather than listed by hand."""
    app = FastAPI()
    app.include_router(
        create_console(
            store=store, secret=SECRET, templates=TEMPLATES,
            secure_cookies=False, client_factory=lambda site: FakeSiteClient(),
        )
    )
    app.include_router(
        create_price_routes(store=store, templates=TEMPLATES,
                            current_user=lambda request: user,
                            client_factory=lambda site: FakeSiteClient())
    )
    app.include_router(
        create_editorial_routes(store=store, templates=TEMPLATES,
                                current_user=lambda request: user, driver=None,
                                default_model="m", extractions=FakeExtractions(),
                                rules=FakeRules(), rounding=FakeRounding(),
                                client_factory=lambda site: FakeSiteClient())
    )
    app.include_router(
        create_reading_routes(store=store, templates=TEMPLATES,
                              current_user=lambda request: user, driver=None,
                              default_model="m", extractions=FakeExtractions())
    )
    app.include_router(
        create_rules_routes(store=store, templates=TEMPLATES,
                            current_user=lambda request: user, rules=FakeRules(),
                            rounding=FakeRounding(),
                            client_factory=lambda site: FakeSiteClient())
    )
    app.include_router(
        create_ai_routes(store=store, providers=FakeProviders(), templates=TEMPLATES,
                         current_user=lambda request: user)
    )

    return app


def every_route_carrying_a_site():
    """Every address the module serves that names a site.

    Asked of the application rather than written down here. A list someone
    has to remember to update is not a guard rail: a route added later
    without the check has to fail a test, and it can only do that if the
    tests find the route themselves.
    """
    found = set()

    for route in whole_console(FakeStore(), RAKESH).routes:
        path = getattr(route, "path", "")

        if "{slug}" not in path:
            continue

        for method in getattr(route, "methods", set()) - {"HEAD", "OPTIONS"}:
            found.add((method, path))

    return sorted(found)


SITE_ROUTES = every_route_carrying_a_site()
SITE_ROUTE_IDS = [f"{method} {path}" for method, path in SITE_ROUTES]


def address_of(path: str) -> str:
    """The route's pattern with a site that exists and 1 for every other id."""
    return re.sub(r"\{[^}]+\}", "1", path.replace("{slug}", "waxreport"))


def ask(store, user, method: str, address: str):
    client = TestClient(whole_console(store, user))
    client.cookies.set(SESSION_COOKIE, sign_session(new_session(user.email), SECRET))

    return client.request(method, address, follow_redirects=False)


class TestEveryAddressThatNamesASite:
    def test_there_are_some_to_check(self):
        # A refactor that stopped the walk finding routes would make every
        # test below pass by checking nothing.
        assert len(SITE_ROUTES) >= 12

    @pytest.mark.parametrize("method,path", SITE_ROUTES, ids=SITE_ROUTE_IDS)
    def test_a_site_you_were_not_given_is_refused(self, method, path):
        granted = FakeStore(grants={RAKESH.id: {"baseoil"}})
        address = address_of(path)

        response = ask(granted, RAKESH, method, address)

        # 404 is the refusal. Two routes answer with a redirect carrying an
        # error instead, and they are named here rather than allowed by shape:
        # the walk posts an empty body, so "redirect with err=" is also what a
        # route that merely failed form validation would emit -- accepting it
        # everywhere would let a genuinely unguarded POST pass this test.
        redirects_instead = {
            ("POST", "/console/settings/sites/{slug}/enabled"),
            ("POST", "/console/settings/ai/site/{slug}"),
        }

        if (method, path) in redirects_instead:
            refused = "err=" in (response.headers.get("location") or "")
        else:
            refused = response.status_code == 404

        assert refused, f"{method} {path} answered {response.status_code} for a site nobody gave"

    @pytest.mark.parametrize("method,path", SITE_ROUTES, ids=SITE_ROUTE_IDS)
    def test_and_answers_exactly_what_a_site_that_does_not_exist_answers(self, method, path):
        granted = FakeStore(grants={RAKESH.id: {"baseoil"}})
        missing = FakeStore(grants={RAKESH.id: {"baseoil", "waxreport"}},
                            sites=[BASEOIL, HIDDEN])
        address = address_of(path)

        ungranted = ask(granted, RAKESH, method, address)
        absent = ask(missing, RAKESH, method, address)

        assert ungranted.status_code == absent.status_code
        assert ungranted.text == absent.text
        assert ungranted.headers.get("location") == absent.headers.get("location")


# One address per guard, for the cases that need a screen to actually render.
# The exhaustive negative check above is taken from the application's own
# routes; these are the positives, which have to name a screen.
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
    def test_it_is_appended_after_rounding(self):
        ids = [row.id for row in MIGRATIONS]

        assert ids.index("0012_site_access") == ids.index("0011_price_rounding") + 1
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


class TestAnAdministratorCannotBecomeTheSuperadmin:
    """The tier is only above administrator if an administrator cannot take it.

    An administrator who could reset the superadmin's password would sign in
    as them, give themselves all nine sites and open the one form that holds
    every site's address and token. Nothing on any screen can make a new
    superadmin, so an administrator who could disable one could stop anybody
    changing who uses what until somebody edited the database by hand.
    """

    def test_an_admin_cannot_reset_the_superadmins_password(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = console_client(store, RAKESH).post(
            f"/console/settings/users/{SUPER.id}/password",
            data={"password": "a-long-enough-one"},
            follow_redirects=False,
        )

        assert store.passwords_set == []
        assert "err=" in (response.headers.get("location") or "")

    def test_an_admin_cannot_disable_the_superadmin(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        response = console_client(store, RAKESH).post(
            f"/console/settings/users/{SUPER.id}/disabled",
            data={"disabled": "1"},
            follow_redirects=False,
        )

        assert store.disabled_set == []
        assert "err=" in (response.headers.get("location") or "")

    def test_an_admin_is_not_even_offered_the_buttons(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})

        page = console_client(store, RAKESH).get("/console/settings/users").text

        assert "Only the superadmin can change this account." in page

    def test_the_superadmin_can_still_reset_their_own_password(self):
        store = FakeStore(grants={})

        console_client(store, SUPER).post(
            f"/console/settings/users/{SUPER.id}/password",
            data={"password": "a-long-enough-one"},
            follow_redirects=False,
        )

        assert store.passwords_set == [SUPER.id]

    def test_an_admin_can_still_reset_an_ordinary_users_password(self):
        store = FakeStore(grants={})

        console_client(store, RAKESH).post(
            f"/console/settings/users/{EDITOR.id}/password",
            data={"password": "a-long-enough-one"},
            follow_redirects=False,
        )

        assert store.passwords_set == [EDITOR.id]

    def test_the_last_superadmin_cannot_be_disabled_at_all(self):
        # Not even by themselves: there is no screen that can make another.
        store = FakeStore(grants={})

        response = console_client(store, SUPER).post(
            f"/console/settings/users/{SUPER.id}/disabled",
            data={"disabled": "1"},
            follow_redirects=False,
        )

        assert store.disabled_set == []
        assert "last%20superadmin" in (response.headers.get("location") or "")

    def test_the_last_administrator_check_counts_the_superadmin_as_one(self):
        """A superadmin is an administrator whether or not the column says so.

        The check has to ask may_change_settings rather than read is_admin,
        and the difference only shows on a superadmin whose own is_admin is
        unset: counting the column would see no administrator left and refuse
        to disable the last one, locking the screen against a console that
        still has a superadmin running it.
        """
        bare_super = dataclasses.replace(SUPER, is_admin=False)
        only_admin = dataclasses.replace(RAKESH, is_superadmin=False)
        store = FakeStore(grants={}, users=[bare_super, only_admin])

        console_client(store, bare_super).post(
            f"/console/settings/users/{only_admin.id}/disabled",
            data={"disabled": "1"},
            follow_redirects=False,
        )

        # Allowed, because the superadmin is still an administrator.
        assert store.disabled_set == [(only_admin.id, True)]


class ScopedRules:
    """Rules that know which site each of them belongs to -- what the store
    now enforces in SQL."""

    def __init__(self, owner):
        self.owner = dict(owner)
        self.toggled = []
        self.deleted = []

    def for_site(self, slug):
        return []

    def set_enabled(self, site_slug, rule_id, enabled):
        if self.owner.get(rule_id) != site_slug:
            return False

        self.toggled.append((rule_id, enabled))

        return True

    def delete(self, site_slug, rule_id):
        if self.owner.get(rule_id) != site_slug:
            return False

        self.deleted.append(rule_id)

        return True


class ScopedRounding(FakeRounding):
    def __init__(self, owner):
        self.owner = dict(owner)
        self.deleted = []

    def delete(self, site_slug, override_id):
        if self.owner.get(override_id) != site_slug:
            return False

        self.deleted.append(override_id)

        return True


class TestAnIdOffTheAddressBarIsNeverEnoughOnItsOwn:
    """Being allowed to use one site must not reach another site's rows.

    The rule and rounding ids are small sequential numbers, so a user given
    only baseoil could post waxreport's rule id to baseoil's own screen and
    turn off or delete a rule that decides what that other site publishes
    next -- while the trail recorded it against baseoil.
    """

    def test_another_sites_rule_cannot_be_turned_off(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})
        rules = ScopedRules({7: "waxreport"})

        response = rules_client(store, RAKESH, rules=rules).post(
            "/console/sites/baseoil/rules/7/toggle",
            data={"enabled": "0"}, follow_redirects=False,
        )

        assert rules.toggled == []
        assert store.records == []
        assert "err=" in (response.headers.get("location") or "")

    def test_another_sites_rule_cannot_be_deleted(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})
        rules = ScopedRules({7: "waxreport"})

        response = rules_client(store, RAKESH, rules=rules).post(
            "/console/sites/baseoil/rules/7/delete", follow_redirects=False
        )

        assert rules.deleted == []
        assert store.records == []
        assert "err=" in (response.headers.get("location") or "")

    def test_another_sites_rounding_step_cannot_be_removed(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})
        rounding = ScopedRounding({9: "waxreport"})

        response = rules_client(store, RAKESH, rounding=rounding).post(
            "/console/sites/baseoil/rounding/override/9/delete", follow_redirects=False
        )

        assert rounding.deleted == []
        assert store.records == []
        assert "err=" in (response.headers.get("location") or "")

    def test_the_sites_own_rule_still_works(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})
        rules = ScopedRules({3: "baseoil"})

        rules_client(store, RAKESH, rules=rules).post(
            "/console/sites/baseoil/rules/3/toggle",
            data={"enabled": "0"}, follow_redirects=False,
        )

        assert rules.toggled == [(3, False)]
        assert [row[1] for row in store.records] == ["turned a price rule off"]

    def test_the_sites_own_rounding_step_still_goes(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil"}})
        rounding = ScopedRounding({9: "baseoil"})

        rules_client(store, RAKESH, rounding=rounding).post(
            "/console/sites/baseoil/rounding/override/9/delete", follow_redirects=False
        )

        assert rounding.deleted == [9]


class FakeConnection:
    def __init__(self, log, row):
        self._log = log
        self._row = row

    def execute(self, sql, params=None):
        self._log.append((" ".join(sql.split()), params))

        return self

    def commit(self):
        return None

    def fetchone(self):
        return self._row


class FakePool:
    def __init__(self, row=None):
        self.statements = []
        self._row = row

    def connection(self):
        log, row = self.statements, self._row

        class Scope:
            def __enter__(self):
                return FakeConnection(log, row)

            def __exit__(self, *args):
                return False

        return Scope()


class TestTheStoreItselfRefusesAnIdFromAnotherSite:
    """Where it cannot be forgotten: the site is in the WHERE clause, so a
    route that forgot to check would still change nothing."""

    def test_turning_a_rule_off_is_scoped_to_the_site(self):
        pool = FakePool(row=(7,))

        assert RulesStore(pool).set_enabled("baseoil", 7, False) is True

        sql, params = pool.statements[0]

        assert "WHERE id = %s AND site_slug = %s" in sql
        assert params == (False, 7, "baseoil")

    def test_a_rule_that_is_not_this_sites_changes_nothing(self):
        pool = FakePool(row=None)

        assert RulesStore(pool).set_enabled("baseoil", 7, False) is False

    def test_deleting_a_rule_is_scoped_to_the_site(self):
        pool = FakePool(row=(7,))

        assert RulesStore(pool).delete("baseoil", 7) is True

        sql, params = pool.statements[0]

        assert "WHERE id = %s AND site_slug = %s" in sql
        assert params == (7, "baseoil")

    def test_a_rule_of_another_site_is_not_deleted(self):
        assert RulesStore(FakePool(row=None)).delete("baseoil", 7) is False

    def test_deleting_a_rounding_step_is_scoped_to_the_site(self):
        pool = FakePool(row=(9,))

        assert RoundingStore(pool).delete("baseoil", 9) is True

        sql, params = pool.statements[0]

        assert "WHERE id = %s AND site_slug = %s" in sql
        assert params == (9, "baseoil")

    def test_a_rounding_step_of_another_site_is_not_deleted(self):
        assert RoundingStore(FakePool(row=None)).delete("baseoil", 9) is False


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


class TestTheSuperadminSeesHiddenSitesToo:
    """The Show/Hide switch is the superadmin's own control.

    Applying it to their own view meant the one person who can turn a site
    back on could not see it to do so: with seven of nine sites hidden, the
    All sites screen offered two.
    """

    def test_all_sites_lists_the_hidden_ones_for_a_superadmin(self):
        store = FakeStore(grants={})

        page = console_client(store, SUPER).get("/console").text

        # BASEOIL and WAX are shown; HIDDEN ("Bitumen Report") is not.
        assert "Base Oil Report" in page
        assert "Wax Report" in page
        assert "Bitumen Report" in page

    def test_an_ordinary_user_still_does_not_see_a_hidden_site(self):
        store = FakeStore(grants={RAKESH.id: {"baseoil", "waxreport", "bitumen"}})

        page = console_client(store, RAKESH).get("/console").text

        assert "Base Oil Report" in page
        assert "Bitumen Report" not in page

    def test_a_superadmin_can_open_a_hidden_site(self):
        # Listing it and then refusing to open it would be worse than hiding it.
        store = FakeStore(grants={})

        response = console_client(store, SUPER).get("/console/sites/bitumen")

        assert response.status_code == 200

    def test_an_ordinary_user_cannot_open_a_hidden_site_even_if_granted(self):
        store = FakeStore(grants={RAKESH.id: {"bitumen"}})

        response = console_client(store, RAKESH).get("/console/sites/bitumen")

        assert response.status_code == 404
