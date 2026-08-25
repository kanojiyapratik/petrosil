"""The derived-price rulebook screen.

The percentages are the owner's editorial policy ("South Korea is always 10%
under Singapore"), so they are edited on a screen, not in code or prompts.
The editorial draft applies whatever this screen holds.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..db.store import RulesStore, Store, StoredSite
from .routes import tone_for
from .site_client import SiteClient, SiteError


def create_rules_routes(
    *,
    store: Store,
    rules: RulesStore,
    templates: Jinja2Templates,
    current_user,
    client_factory=None,
) -> APIRouter:
    router = APIRouter()

    def client_for(site: StoredSite) -> SiteClient:
        if client_factory is not None:
            return client_factory(site)

        return SiteClient(base_url=site.api_url, token=site.token, name=site.name)

    def guard(request: Request, slug: str):
        user = current_user(request)

        if user is None:
            return None, None, RedirectResponse("/console/login", status_code=303)

        site = store.site_by_slug(slug)

        if site is None or not site.enabled:
            return (
                user,
                None,
                templates.TemplateResponse(
                    request,
                    "error.html",
                    {
                        "user": user, "flash": None, "site": None, "section": None,
                        "crumbs": None, "tone_for": tone_for, "title": "No such site",
                        "message": "That site is not configured, or has been turned off.",
                    },
                    status_code=404,
                ),
            )

        return user, site, None

    def back(slug: str, kind: str, text: str) -> RedirectResponse:
        return RedirectResponse(
            f"/console/sites/{slug}/rules?{kind}={quote(text)}", status_code=303
        )

    @router.get("/console/sites/{slug}/rules", response_class=HTMLResponse)
    def rules_screen(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        try:
            locations = client_for(site).locations().get("data", [])
        except SiteError:
            locations = []

        flash = None

        if request.query_params.get("ok"):
            flash = {"kind": "ok", "text": request.query_params["ok"]}
        elif request.query_params.get("err"):
            flash = {"kind": "bad", "text": request.query_params["err"]}

        return templates.TemplateResponse(
            request,
            "rules.html",
            {
                "user": user,
                "flash": flash,
                "site": site,
                "section": "rules",
                "crumbs": [
                    {"label": site.name, "href": f"/console/sites/{site.slug}"},
                    {"label": "Price rules"},
                ],
                "tone_for": tone_for,
                "title": f"Price rules · {site.name}",
                "rules": rules.for_site(site.slug),
                "locations": locations,
            },
        )

    @router.post("/console/sites/{slug}/rules")
    async def add_rule(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        derived = str(form.get("derived_location") or "").strip()
        reference = str(form.get("reference_location") or "").strip()
        raw_pct = str(form.get("adjustment_pct") or "").strip()

        if not derived or not reference:
            return back(site.slug, "err", "Pick both locations.")

        if derived == reference:
            return back(site.slug, "err", "A price cannot be calculated from itself.")

        try:
            pct = float(raw_pct)
        except ValueError:
            return back(site.slug, "err", "The adjustment must be a number, e.g. -10 for 10% less.")

        if not -95 <= pct <= 95:
            return back(site.slug, "err", "The adjustment must be between -95 and +95 percent.")

        rules.create(site.slug, derived, reference, pct)
        store.record(
            user.email, "set a price rule", site.slug, f"{derived} = {reference} {pct:+g}%"
        )

        return back(site.slug, "ok", f"Rule saved: {derived} = {reference} {pct:+g}%.")

    @router.post("/console/sites/{slug}/rules/{rule_id}/toggle")
    async def toggle_rule(request: Request, slug: str, rule_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        enabled = str(form.get("enabled") or "") == "1"
        rules.set_enabled(rule_id, enabled)
        store.record(
            user.email,
            "turned a price rule " + ("on" if enabled else "off"),
            site.slug,
            f"rule #{rule_id}",
        )

        return back(site.slug, "ok", "Rule turned " + ("on." if enabled else "off."))

    @router.post("/console/sites/{slug}/rules/{rule_id}/delete")
    async def delete_rule(request: Request, slug: str, rule_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        rules.delete(rule_id)
        store.record(user.email, "removed a price rule", site.slug, f"rule #{rule_id}")

        return back(site.slug, "ok", "Rule removed.")

    return router
