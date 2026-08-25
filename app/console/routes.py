"""The console: sign in, pick a site, work on it.

Every screen is a form post and a redirect. The console keeps no price data of
its own -- it reads and writes through each site's API with that site's token,
which is what lets one deployment serve all of them. Its own database holds
only who may sign in, which sites exist, and what was done.
"""

from __future__ import annotations

from urllib.parse import quote, urlparse

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..db.store import Store, StoredSite, StoredUser
from .auth import (
    SESSION_COOKIE,
    authenticate,
    hash_password,
    new_session,
    read_session,
    sign_session,
    verify_password,
)
from .config import ConsoleConfigError, normalise_site_input
from .crawl_now import crawl_site_now, describe
from .site_client import SiteClient, SiteError

# The site's own statuses, mirrored so the screen tells the truth about what
# will happen. Showing a commit button the site is going to refuse is worse
# than showing none.
STATUS_TONE = {
    "changed": "ok",
    "new": "ok",
    "committed": "ok",
    "updated": "ok",
    "unchanged": "mute",
    "locked": "mute",
    "draft": "mute",
    "no_change": "mute",
    "discarded": "mute",
    "ambiguous": "warn",
    "unmatched": "warn",
    "no_rows": "warn",
    "rolled_back": "warn",
    "invalid": "bad",
    "conflict": "bad",
    "blocked": "bad",
    "disallowed": "bad",
    "failed": "bad",
    "gone": "bad",
}

NEEDS_ATTENTION = ("ambiguous", "unmatched", "invalid")
VALUE_EDITABLE = ("changed", "new", "ambiguous", "unmatched")


def tone_for(status: str | None) -> str:
    return STATUS_TONE.get(status or "", "mute")


# What the screens SAY. The wire values stay technical (sites depend on
# them); the editors reading the screens are not developers, so "commit",
# "rollback" and "unmatched" become words a person would use. Owner's ask.
STATUS_LABELS = {
    "draft": "waiting for approval",
    "committed": "published",
    "rolled_back": "undone",
    "discarded": "deleted",
    "new": "new price",
    "changed": "price change",
    "unchanged": "no change",
    "locked": "date already published",
    "unmatched": "location not recognised",
    "ambiguous": "matches several locations",
    "invalid": "cannot be used",
    "conflict": "conflicting rows",
    "suggested": "suggested",
    "near_match": "close match",
    "derived": "calculated by rule",
    "no_evidence": "not in the reports",
    "upload": "file upload",
    "bulk_edit": "bulk edit",
    "crawl": "watched URL",
    "editorial": "AI editorial",
    "api": "API",
}


def label_for(status: str | None) -> str:
    return STATUS_LABELS.get(status or "", status or "—")


def create_console(
    *,
    store: Store,
    providers=None,
    secret: str,
    templates: Jinja2Templates,
    secure_cookies: bool = True,
    client_factory=None,
) -> APIRouter:
    router = APIRouter()

    def client_for(site: StoredSite) -> SiteClient:
        if client_factory is not None:
            return client_factory(site)

        return SiteClient(base_url=site.api_url, token=site.token, name=site.name)

    def current_user(request: Request) -> StoredUser | None:
        """The signed-in user, or None if the cookie names someone who is not
        one any more -- disabled accounts stop working immediately rather than
        when their cookie happens to expire."""
        session = read_session(request.cookies.get(SESSION_COOKIE), secret)

        if session is None:
            return None

        return next((user for user in store.active_users() if user.email == session.email), None)

    def page(name: str, request: Request, user: StoredUser, **context) -> HTMLResponse:
        flash = None

        if request.query_params.get("ok"):
            flash = {"kind": "ok", "text": request.query_params["ok"]}
        elif request.query_params.get("err"):
            flash = {"kind": "bad", "text": request.query_params["err"]}

        return templates.TemplateResponse(
            request,
            name,
            {
                "user": user,
                "flash": flash,
                "site": None,
                "section": None,
                "crumbs": None,
                "tone_for": tone_for,
                **context,
            },
            status_code=context.pop("status_code", 200),
        )

    def back(path: str, kind: str, text: str) -> RedirectResponse:
        return RedirectResponse(f"{path}?{kind}={quote(text)}", status_code=303)

    def error_page(request, user, title, message, status_code=200) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "error.html",
            {
                "user": user,
                "flash": None,
                "site": None,
                "section": None,
                "crumbs": None,
                "tone_for": tone_for,
                "title": title,
                "message": message,
            },
            status_code=status_code,
        )

    # ---- sign in ---------------------------------------------------------

    @router.get("/console/login", response_class=HTMLResponse)
    def login_form(request: Request):
        return templates.TemplateResponse(request, "login.html", {"title": "Sign in", "error": None})

    @router.post("/console/login")
    async def login(request: Request):
        form = await request.form()
        user = authenticate(
            store.active_users(), str(form.get("email") or ""), str(form.get("password") or "")
        )

        if user is None:
            # One message for both wrong-email and wrong-password: saying
            # which would tell a stranger which addresses have accounts.
            return templates.TemplateResponse(
                request,
                "login.html",
                {"title": "Sign in", "error": "Those details are not right."},
                status_code=401,
            )

        response = RedirectResponse("/console", status_code=303)
        response.set_cookie(
            SESSION_COOKIE,
            sign_session(new_session(user.email), secret),
            httponly=True,
            samesite="lax",
            secure=secure_cookies,
            path="/",
        )

        store.record(user.email, "signed in")

        return response

    @router.post("/console/logout")
    def logout():
        response = RedirectResponse("/console/login", status_code=303)
        response.delete_cookie(SESSION_COOKIE, path="/")

        return response

    # ---- sites -----------------------------------------------------------

    @router.get("/console", response_class=HTMLResponse)
    def sites(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        return page("sites.html", request, user, title="Sites", sites=store.enabled_sites())

    @router.get("/console/sites/{slug}", response_class=HTMLResponse)
    def site_home(request: Request, slug: str):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None or not site.enabled:
            return error_page(request, user, "No such site", "That site is not configured, or has been turned off.", 404)

        return page(
            "site.html",
            request,
            user,
            title=site.name,
            site=site,
            crumbs=[{"label": site.name}],
            recent=store.audit(8, site.slug),
        )

    # ---- crawler ---------------------------------------------------------

    @router.get("/console/sites/{slug}/crawler", response_class=HTMLResponse)
    def crawler(request: Request, slug: str):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None or not site.enabled:
            return error_page(request, user, "No such site", "That site is not configured.", 404)

        try:
            client = client_for(site)
            urls = client.watched_urls()
            activity = client.activity(50)
        except SiteError as error:
            return error_page(request, user, "Could not reach the site", str(error), 502)

        rows = []

        for entry in urls.get("data", []):
            rows.append({**entry, "tone": tone_for(entry.get("last_status"))})

        found = []

        for row in activity.get("data", []):
            host = None

            if row.get("url"):
                host = urlparse(row["url"]).hostname

            found.append({**row, "host": host})

        return page(
            "crawler.html",
            request,
            user,
            title=f"Crawler · {site.name}",
            site=site,
            section="crawler",
            crumbs=[{"label": site.name, "href": f"/console/sites/{site.slug}"}, {"label": "Crawler"}],
            urls=rows,
            activity=found,
            interval_minutes=urls.get("interval_minutes", 15),
        )

    @router.post("/console/sites/{slug}/crawler/urls")
    async def save_urls(request: Request, slug: str):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None:
            return RedirectResponse("/console", status_code=303)

        form = await request.form()
        path = f"/console/sites/{site.slug}/crawler"

        try:
            result = client_for(site).replace_watched_urls(str(form.get("text") or ""))
        except SiteError as error:
            return back(path, "err", str(error))

        store.record(
            user.email,
            "saved watched URLs",
            site.slug,
            f"{result.get('watched')} watched, {result.get('added')} added, {result.get('stopped')} stopped",
        )

        return back(
            path,
            "ok",
            f"Saved. {result.get('watched')} watched, {result.get('added')} added, "
            f"{result.get('reenabled')} re-enabled, {result.get('stopped')} stopped.",
        )

    @router.post("/console/sites/{slug}/crawler/stage")
    async def stage(request: Request, slug: str):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None:
            return RedirectResponse("/console", status_code=303)

        form = await request.form()
        ids = [int(value) for value in form.getlist("activity_ids") if str(value).isdigit()]
        path = f"/console/sites/{site.slug}/crawler"

        if not ids:
            return back(path, "err", "Nothing was selected.")

        try:
            result = client_for(site).stage(ids)
        except SiteError as error:
            return back(path, "err", str(error))

        store.record(
            user.email,
            "staged a batch from crawled prices",
            site.slug,
            f"batch #{result.get('batch_id')}, {result.get('rows')} row(s)",
        )

        return back(
            path,
            "ok",
            f"Staged batch #{result.get('batch_id')} with {result.get('rows')} row(s). "
            "Nothing is committed yet.",
        )

    @router.post("/console/sites/{slug}/crawler/check")
    async def check_now(request: Request, slug: str):
        """The button that saves waiting a quarter of an hour after adding a
        URL. Runs one pass, synchronously -- it takes seconds when the pages
        have not changed, and an admin who pressed a button should see the
        answer rather than be told to come back."""
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None:
            return RedirectResponse("/console", status_code=303)

        path = f"/console/sites/{site.slug}/crawler"
        form = await request.form()

        # Ticking the box runs the pass with no model at all. It answers a
        # different question from the normal run: not "what do these pages
        # say" but "is the crawler reaching them", which is otherwise
        # indistinguishable from the model being unavailable.
        without_ai = form.get("without_ai") in ("on", "1")

        try:
            outcomes = crawl_site_now(site, use_rules=without_ai or None, providers=providers)
        except Exception as error:  # noqa: BLE001 - report it, never 500 the screen
            return back(path, "err", str(error))

        store.record(
            user.email,
            "ran a crawl by hand",
            site.slug,
            f"{len(outcomes)} URL(s)" + (" — without AI" if without_ai else ""),
        )

        return back(path, "ok", describe(outcomes, used_rules=without_ai))

    # ---- your own account -------------------------------------------------

    @router.get("/console/account", response_class=HTMLResponse)
    def account(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        return page("account.html", request, user, title="Your account", section="account")

    @router.post("/console/account/password")
    async def change_password(request: Request):
        """Changing your own password needs the current one.

        Without that check, anyone who found an unattended signed-in browser
        could lock the owner out of their own account.
        """
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        form = await request.form()
        path = "/console/account"
        current = str(form.get("current") or "")
        new = str(form.get("new") or "")

        if not verify_password(current, user.password_hash):
            return back(path, "err", "That is not your current password.")

        if new != str(form.get("confirm") or ""):
            return back(path, "err", "The two new passwords do not match.")

        if len(new) < 10:
            return back(path, "err", "Use a password of at least 10 characters.")

        if verify_password(new, user.password_hash):
            return back(path, "err", "That is already your password.")

        store.set_user_password(user.id, hash_password(new))
        # The password itself is never recorded, only that it changed.
        store.record(user.email, "changed their password")

        return back(path, "ok", "Password changed.")

    @router.post("/console/sites/{slug}/crawler/clear")
    def clear_findings(request: Request, slug: str):
        """Forget what the pages have said so far.

        Findings pile up from diagnostic runs and from sources that turned out
        to publish something other than prices. Nothing here touches a price --
        activity is only a record of what a page said -- but the pages are all
        re-read afterwards, since their history no longer exists to compare
        against.
        """
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None:
            return RedirectResponse("/console", status_code=303)

        path = f"/console/sites/{site.slug}/crawler"

        try:
            result = client_for(site).clear_activity()
        except SiteError as error:
            return back(path, "err", str(error))

        removed = result.get("removed", 0)
        store.record(user.email, "cleared crawler findings", site.slug, f"{removed} row(s)")

        return back(path, "ok", f"Cleared {removed} finding(s). The pages will be read afresh.")

    # ---- settings --------------------------------------------------------

    @router.get("/console/settings/sites", response_class=HTMLResponse)
    def settings_sites(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        return page(
            "settings_sites.html",
            request,
            user,
            title="Sites",
            section="sites",
            crumbs=[{"label": "Settings"}, {"label": "Sites"}],
            sites=store.sites(),
        )

    @router.post("/console/settings/sites")
    async def save_site(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        form = await request.form()
        path = "/console/settings/sites"

        try:
            site = normalise_site_input(
                slug=str(form.get("slug") or ""),
                name=str(form.get("name") or ""),
                api_url=str(form.get("api_url") or ""),
                api_token=str(form.get("api_token") or ""),
                enabled=form.get("enabled") in ("on", "1"),
            )
        except ConsoleConfigError as error:
            return back(path, "err", str(error))

        existing = store.site_by_slug(site.slug)

        if existing is None and site.api_token == "":
            return back(path, "err", "A new site needs an API token.")

        store.upsert_site(site.slug, site.name, site.api_url, site.api_token, site.enabled)
        store.record(
            user.email, "updated a site" if existing else "added a site", site.slug, site.api_url
        )

        return back(path, "ok", f"{site.name} saved.")

    @router.get("/console/settings/users", response_class=HTMLResponse)
    def settings_users(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        return page(
            "settings_users.html",
            request,
            user,
            title="Users",
            section="users",
            crumbs=[{"label": "Settings"}, {"label": "Users"}],
            users=store.users(),
        )

    @router.post("/console/settings/users")
    async def add_user(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        form = await request.form()
        path = "/console/settings/users"
        email = str(form.get("email") or "").strip().lower()
        password = str(form.get("password") or "")

        if "@" not in email or "." not in email.split("@")[-1]:
            return back(path, "err", "That is not an email address.")

        if len(password) < 10:
            return back(path, "err", "Use a password of at least 10 characters.")

        try:
            store.create_user(
                email,
                str(form.get("name") or "").strip() or email,
                hash_password(password),
                form.get("is_admin") in ("on", "1"),
            )
        except Exception as error:  # noqa: BLE001 - a duplicate is the expected case
            message = str(error)

            return back(
                path,
                "err",
                "That email already has an account."
                if "console_users_email_key" in message
                else message,
            )

        store.record(user.email, "added a user", None, email)

        return back(path, "ok", f"{email} can now sign in.")

    @router.post("/console/settings/users/{user_id}/password")
    async def reset_password(request: Request, user_id: int):
        """An administrator setting someone else's password.

        The other half of the same gap: without this, a forgotten password
        needed a hand-generated hash and an environment variable.
        """
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        form = await request.form()
        path = "/console/settings/users"
        new = str(form.get("password") or "")
        target = next((row for row in store.users() if row.id == user_id), None)

        if target is None:
            return back(path, "err", "No such user.")

        if len(new) < 10:
            return back(path, "err", "Use a password of at least 10 characters.")

        store.set_user_password(user_id, hash_password(new))
        store.record(user.email, "reset a password", None, target.email)

        return back(path, "ok", f"{target.email} has a new password.")

    @router.post("/console/settings/users/{user_id}/disabled")
    async def set_user_disabled(request: Request, user_id: int):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        form = await request.form()
        disabled = str(form.get("disabled") or "") == "1"
        path = "/console/settings/users"
        users = store.users()
        target = next((row for row in users if row.id == user_id), None)

        if target is None:
            return back(path, "err", "No such user.")

        # Locking every administrator out of a console whose settings only an
        # administrator can reach would need a database edit to undo.
        other_admins = [
            row for row in users if row.is_admin and row.disabled_at is None and row.id != user_id
        ]

        if disabled and target.is_admin and not other_admins:
            return back(
                path,
                "err",
                "That is the last administrator — disabling it would lock everyone out.",
            )

        store.set_user_disabled(user_id, disabled)
        store.record(
            user.email, "disabled a user" if disabled else "enabled a user", None, target.email
        )

        return back(path, "ok", f"{target.email} {'disabled' if disabled else 'enabled'}.")

    return router
