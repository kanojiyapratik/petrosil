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
from .access import (
    SUPERADMIN_ONLY,
    is_superadmin,
    make_site_guard,
    managed_site,
    may_change_settings,
    sites_for,
    visible_sites,
)
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
    "committed": "saved to website",
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
    "foreign": "not in USD",
    "needs_rate": "needs manual review — no exchange rate",
    "upload": "file upload",
    "bulk_edit": "bulk edit",
    "crawl": "watched URL",
    "editorial": "AI editorial",
    "api": "API",
}


def label_for(status: str | None) -> str:
    return STATUS_LABELS.get(status or "", status or "—")


def datefmt(value) -> str:
    """DD-MM-YY, the one date format on every screen. Anything that is not an
    ISO date passes through untouched rather than crashing a page over it."""
    if value is None:
        return "—"

    text = str(value)

    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        year, month, day = text[0:4], text[5:7], text[8:10]

        return f"{day}-{month}-{year[2:]}"

    return text


def create_console(
    *,
    store: Store,
    providers=None,
    secret: str,
    templates: Jinja2Templates,
    secure_cookies: bool = True,
    client_factory=None,
    driver=None,
    default_model: str = "gemini-2.5-flash",
    driver_for=None,
    usage=None,
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

    # The one site guard, shared with every other router: see access.py. A
    # slug that names a site this user has not been given resolves to nothing
    # here, exactly as a hidden or missing one does.
    guard = make_site_guard(store=store, templates=templates, current_user=current_user)

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

        return page(
            "sites.html",
            request,
            user,
            title="Sites",
            sites=sites_for(store, user),
        )

    @router.get("/console/sites/{slug}", response_class=HTMLResponse)
    def site_home(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

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
        user, site, response = guard(request, slug)

        if response is not None:
            return response

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

            found.append({**row, "host": host, "ai_match": None, "ai_caution": None})

        # Findings the site has no location for: the model proposes which
        # tracked location each belongs to, with a caution when something is
        # off (a different currency, per-litre pricing). The person confirms
        # in a picker; a model failure just means no proposals.
        location_titles = []
        location_prices = {}
        unmatched = [row for row in found if not row.get("location_id") and row.get("id")]

        if unmatched:
            try:
                for entry in client.locations().get("data", []):
                    title = str(entry.get("title") or "")

                    if title:
                        location_titles.append(title)
                        location_prices[title] = entry.get("latest_price")
            except SiteError:
                location_titles = []

        if unmatched and location_titles and (driver is not None or driver_for is not None):
            from ..editorial.match import build_match_prompt, parse_match_answer

            chosen = driver_for(site.slug) if driver_for is not None else None
            active = chosen or driver
            model = getattr(chosen, "model", default_model) if chosen else default_model

            try:
                prompt = build_match_prompt(
                    [{"id": r["id"], "location": r.get("location"), "price": r.get("price")} for r in unmatched],
                    location_titles,
                )
                completion = (
                    active.generate(prompt) if chosen is not None else active.generate(model, prompt)
                )

                if usage is not None:
                    usage.record(
                        kind="crawler_match",
                        provider=getattr(active, "provider_key", "gemini"),
                        model=model,
                        status=completion.status,
                        prompt_tokens=completion.prompt_tokens,
                        completion_tokens=completion.completion_tokens,
                        site_slug=site.slug,
                    )

                proposals = parse_match_answer(
                    completion.text, {r["id"] for r in unmatched}, location_titles
                )

                for row in found:
                    proposal = proposals.get(row.get("id"))

                    if proposal:
                        row["ai_match"] = proposal["match"]
                        row["ai_caution"] = proposal["caution"] or None
                        # What the site currently holds for the proposed
                        # location, so the reader can compare before agreeing.
                        row["ai_site_price"] = (
                            location_prices.get(proposal["match"])
                            if proposal["match"]
                            else None
                        )
            except Exception:  # noqa: BLE001 - proposals are a convenience, never a blocker
                pass

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
            locations=location_titles,
            interval_minutes=urls.get("interval_minutes", 15),
            instructions=urls.get("instructions"),
        )

    @router.post("/console/sites/{slug}/crawler/urls")
    async def save_urls(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        path = f"/console/sites/{site.slug}/crawler"

        try:
            # The instructions live on the site with the URL list, so the
            # crawler's own 15-minute loop sees them too. Sent even when
            # blank: blank is how they are cleared.
            result = client_for(site).replace_watched_urls(
                str(form.get("text") or ""),
                instructions=str(form.get("instructions") or ""),
            )
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
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        ids = [int(value) for value in form.getlist("activity_ids") if str(value).isdigit()]
        path = f"/console/sites/{site.slug}/crawler"
        client = client_for(site)

        # Human-matched findings: the page's own label was not a tracked
        # location, and the person picked which one it belongs to. Staged as
        # structured rows under the crawl label, price and date from the
        # finding itself.
        manual_rows = []
        manual_count = 0
        by_id = {}

        for key in form.keys():
            if key.startswith("manual_") and not key.startswith("manual_loc_"):
                if not by_id:
                    try:
                        by_id = {
                            entry.get("id"): entry
                            for entry in client.activity(50).get("data", [])
                        }
                    except SiteError as error:
                        return back(path, "err", str(error))

                try:
                    finding_id = int(key.split("_", 1)[1])
                except ValueError:
                    continue

                chosen_location = str(form.get(f"manual_loc_{finding_id}") or "").strip()
                finding = by_id.get(finding_id)

                if not chosen_location or finding is None:
                    continue

                manual_rows.append(
                    {
                        "location": chosen_location,
                        "price": finding.get("price"),
                        "date": finding.get("price_date"),
                    }
                )
                manual_count += 1
                store.record(
                    user.email,
                    "matched a crawled price to a location",
                    site.slug,
                    f"\"{finding.get('location')}\" -> {chosen_location} at {finding.get('price')}",
                )

        if not ids and not manual_rows:
            return back(path, "err", "Nothing was selected.")

        messages = []

        try:
            if ids:
                result = client.stage(ids)
                messages.append(
                    f"Staged update #{result.get('batch_id')} with {result.get('rows')} row(s)."
                )
                store.record(
                    user.email,
                    "staged a batch from crawled prices",
                    site.slug,
                    f"batch #{result.get('batch_id')}, {result.get('rows')} row(s)",
                )

            if manual_rows:
                manual = client.stage_rows(manual_rows, source="crawl")
                manual_id = manual.get("batch", {}).get("id")
                messages.append(
                    f"Staged update #{manual_id} with {manual_count} human-matched row(s)."
                )
                store.record(
                    user.email,
                    "staged human-matched crawled prices",
                    site.slug,
                    f"batch #{manual_id}, {manual_count} row(s)",
                )
        except SiteError as error:
            return back(path, "err", str(error))

        return back(path, "ok", " ".join(messages) + " Nothing is on the website yet.")

    @router.post("/console/sites/{slug}/crawler/check")
    async def check_now(request: Request, slug: str):
        """The button that saves waiting a quarter of an hour after adding a
        URL. Runs one pass, synchronously -- it takes seconds when the pages
        have not changed, and an admin who pressed a button should see the
        answer rather than be told to come back."""
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        path = f"/console/sites/{site.slug}/crawler"

        try:
            outcomes = crawl_site_now(site, providers=providers)
        except Exception as error:  # noqa: BLE001 - report it, never 500 the screen
            return back(path, "err", str(error))

        store.record(user.email, "ran a crawl by hand", site.slug, f"{len(outcomes)} URL(s)")

        return back(path, "ok", describe(outcomes))

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
        user, site, response = guard(request, slug)

        if response is not None:
            return response

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

        if not may_change_settings(user):
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        return page(
            "settings_sites.html",
            request,
            user,
            title="Sites",
            section="sites",
            crumbs=[{"label": "Settings"}, {"label": "Sites"}],
            sites=visible_sites(store, user, store.sites()),
        )

    @router.post("/console/settings/sites")
    async def save_site(request: Request):
        """Adding a site, or rewriting its address or token.

        The superadmin's job, not an ordinary administrator's: this form is
        the one that can point a site's screens at a different address or
        replace the token they all depend on.
        """
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not is_superadmin(user):
            return error_page(request, user, "Not allowed", SUPERADMIN_ONLY, 403)

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

    @router.post("/console/settings/sites/{slug}/enabled")
    async def set_site_enabled(request: Request, slug: str):
        """Show or hide one site, without touching the rest of its settings.

        A hidden site is not merely unlinked: it is absent from the site list
        and its screens answer 404, so a half-finished site cannot be reached
        by anyone who guesses the address. That is why this is one switch and
        not a note on a page -- and why every flip is written to the trail,
        since it changes what the whole team can see.
        """
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not may_change_settings(user):
            return error_page(
                request, user, "Not allowed",
                "Only an administrator can change these settings.", 403,
            )

        path = "/console/settings/sites"
        form = await request.form()
        wanted = str(form.get("enabled") or "") == "1"

        # managed_site, not visible_site: a hidden site has to still resolve
        # here or the Show switch could never turn one back on. The access
        # check is the same one.
        if managed_site(store, user, slug) is None:
            return back(path, "err", "No such site.")

        site = store.set_site_enabled(slug, wanted)

        if site is None:
            return back(path, "err", "No such site.")

        store.record(
            user.email, "showed a site" if wanted else "hid a site", site.slug, site.name
        )

        return back(
            path, "ok",
            f"{site.name} is now {'visible to everyone' if wanted else 'hidden'}.",
        )

    @router.get("/console/settings/users", response_class=HTMLResponse)
    def settings_users(request: Request):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not may_change_settings(user):
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

        if not may_change_settings(user):
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

        if not may_change_settings(user):
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        form = await request.form()
        path = "/console/settings/users"
        new = str(form.get("password") or "")
        target = next((row for row in store.users() if row.id == user_id), None)

        if target is None:
            return back(path, "err", "No such user.")

        if target.is_superadmin and not is_superadmin(user):
            # Otherwise the whole tier is decoration: an administrator resets
            # the superadmin's password, signs in as them, and gives
            # themselves every site and the form that holds every token.
            return back(path, "err", SUPERADMIN_ONLY)

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

        if not may_change_settings(user):
            return error_page(request, user, "Not allowed", "Only an administrator can change these settings.", 403)

        form = await request.form()
        disabled = str(form.get("disabled") or "") == "1"
        path = "/console/settings/users"
        users = store.users()
        target = next((row for row in users if row.id == user_id), None)

        if target is None:
            return back(path, "err", "No such user.")

        if target.is_superadmin and not is_superadmin(user):
            # The same hole as resetting their password: an administrator who
            # could disable the superadmin could stop anyone changing who uses
            # which website, and no screen can make a new superadmin.
            return back(path, "err", SUPERADMIN_ONLY)

        # Locking every administrator out of a console whose settings only an
        # administrator can reach would need a database edit to undo. A
        # superadmin counts as an administrator here, which is why this asks
        # may_change_settings rather than reading is_admin.
        other_admins = [
            row
            for row in users
            if may_change_settings(row) and row.disabled_at is None and row.id != user_id
        ]

        if disabled and may_change_settings(target) and not other_admins:
            return back(
                path,
                "err",
                "That is the last administrator — disabling it would lock everyone out.",
            )

        # And the superadmin is its own last-one-out case: is_admin is on
        # every administrator, so counting administrators would happily let
        # the only superadmin go. Nothing on any screen can make another.
        other_superadmins = [
            row
            for row in users
            if row.is_superadmin and row.disabled_at is None and row.id != user_id
        ]

        if disabled and target.is_superadmin and not other_superadmins:
            return back(
                path,
                "err",
                "That is the last superadmin — disabling it would leave nobody who can say "
                "who uses which website.",
            )

        store.set_user_disabled(user_id, disabled)
        store.record(
            user.email, "disabled a user" if disabled else "enabled a user", None, target.email
        )

        return back(path, "ok", f"{target.email} {'disabled' if disabled else 'enabled'}.")

    # ---- who can use which website ----------------------------------------

    @router.get("/console/settings/access", response_class=HTMLResponse)
    def settings_access(request: Request):
        """The superadmin's screen: which websites each person may use.

        Not an administrator's screen. Deciding who sees which site is the
        one thing the superadmin tier exists for, and an administrator who
        could edit this could give themselves every site.
        """
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not is_superadmin(user):
            return error_page(request, user, "Not allowed", SUPERADMIN_ONLY, 403)

        grants = store.all_grants()
        rows = [
            {"user": row, "slugs": grants.get(row.id, set())}
            for row in store.users()
            if not row.is_superadmin
        ]

        return page(
            "settings_access.html",
            request,
            user,
            title="Website access",
            section="access",
            crumbs=[{"label": "Settings"}, {"label": "Website access"}],
            rows=rows,
            sites=store.sites(),
        )

    @router.post("/console/settings/access/{user_id}")
    async def save_access(request: Request, user_id: int):
        user = current_user(request)

        if user is None:
            return RedirectResponse("/console/login", status_code=303)

        if not is_superadmin(user):
            return error_page(request, user, "Not allowed", SUPERADMIN_ONLY, 403)

        form = await request.form()
        path = "/console/settings/access"
        target = next((row for row in store.users() if row.id == user_id), None)

        if target is None:
            return back(path, "err", "No such user.")

        if target.is_superadmin:
            # A superadmin sees every site by being one. Rows here would be a
            # second answer to the same question, free to disagree with it.
            return back(path, "err", "The superadmin already uses every website.")

        known = {site.slug for site in store.sites()}
        wanted = {str(value) for value in form.getlist("sites")} & known
        held = store.granted_slugs(user_id)

        for slug in sorted(wanted - held):
            store.grant_site(user_id, slug, user.email)
            # Every change here changes what another person can see, which is
            # exactly what the trail is for.
            store.record(user.email, "gave a user a website", slug, target.email)

        for slug in sorted(held - wanted):
            store.revoke_site(user_id, slug)
            store.record(user.email, "took a website away from a user", slug, target.email)

        return back(path, "ok", f"{target.email} can use {len(wanted)} website(s).")

    return router
