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


def _pct(value: float) -> str:
    return f"{value:+g}%"


def _formula(rule) -> str:
    return f"{rule.reference_location} {_pct(rule.adjustment_pct)}"


def _count(rules) -> str:
    return "1 rule" if len(rules) == 1 else f"{len(rules)} rules"


def _listed(rules, limit: int = 3) -> str:
    shown = [f"{rule.derived_location} {_pct(rule.adjustment_pct)}" for rule in rules[:limit]]
    rest = len(rules) - len(shown)

    if rest > 0:
        shown.append(f"and {rest} more")

    return ", ".join(shown)


def _note(tone: str, title: str, detail: str) -> dict:
    return {"tone": tone, "title": title, "detail": detail}


def build_rule_notes(rules, locations) -> dict:
    """What the rulebook already says about each name, in plain sentences.

    Both fields on this screen are guesswork without it. A location that is
    already calculated must say so -- saving a second rule silently replaces
    the first -- and a location other rules are calculated FROM must say that
    too, because a percentage typed here moves all of them.

    The two halves differ because the same location means different things on
    each side: on the left it is the price being replaced, on the right it is
    the benchmark others hang off.
    """
    derived_by = {}
    references: dict = {}

    for rule in rules:
        derived_by[rule.derived_location] = rule
        references.setdefault(rule.reference_location, []).append(rule)

    titles = {str(entry.get("title")) for entry in locations if entry.get("title")}
    names = set(derived_by) | set(references) | titles
    notes = {}

    for name in sorted(names):
        rule = derived_by.get(name)
        used_by = references.get(name, [])
        count = _count(used_by)

        if rule is not None and used_by:
            flag = "both"
            summary = f"calculated from {_formula(rule)} · source for {count}"
        elif rule is not None:
            flag = "rule"
            summary = f"calculated from {_formula(rule)}"
        elif used_by:
            flag = "source"
            summary = f"source for {count}"
        else:
            flag = ""
            summary = ""

        if rule is not None and rule.enabled:
            derived = _note(
                "warn",
                "This location already has a rule",
                f"{name} is calculated from {_formula(rule)}. Saving replaces that rule.",
            )
        elif rule is not None:
            # create() rewrites the formula and never touches `enabled`, so a
            # replaced rule that was off stays off -- which reads as "nothing
            # happened" unless it is said here.
            summary += " (turned off)"
            derived = _note(
                "warn",
                "This location has a rule that is turned off",
                f"{name} is calculated from {_formula(rule)}. Saving replaces it, and it "
                "stays off until you turn it on in the table below.",
            )
        elif used_by:
            # Rules chain to a fixpoint, so a rule here moves everything below it.
            derived = _note(
                "info",
                f"{count} {'is' if len(used_by) == 1 else 'are'} calculated from this location",
                f"{_listed(used_by)}. A rule here changes what they all start from.",
            )
        else:
            derived = _note(
                "mute",
                "No rule yet",
                f"{name} is priced only from what the reports say. This would be its "
                "first rule.",
            )

        # A reference is resolved by exact name. One that is neither a live
        # location nor a report figure matches nothing, so every rule hanging
        # off it silently never runs -- found on baseoil, where three Bright
        # Stock rules name a location that does not exist.
        orphan = bool(used_by) and name not in titles and not name.lower().startswith("report:")

        if orphan:
            reference = _note(
                "warn",
                "No location and no report figure has this name",
                f"{count} {'is' if len(used_by) == 1 else 'are'} calculated from it — "
                f"{_listed(used_by)} — and none of them can run until the name matches a "
                'location exactly, or is entered as a report figure starting with "Report:".',
            )
        elif used_by:
            detail = f"{_listed(used_by)}."

            if rule is not None:
                detail += (
                    f" It is itself calculated from {_formula(rule)}, so this rule would "
                    "follow on from that one."
                )

            reference = _note("info", f"Already the source for {count}", detail)
        elif rule is not None:
            reference = _note(
                "info",
                "This location is itself calculated",
                f"{name} is calculated from {_formula(rule)}, so this rule would follow "
                "on from that one.",
            )
        else:
            reference = _note(
                "mute",
                "Not used by any rule yet",
                f"This would be the first price calculated from {name}.",
            )

        notes[name] = {
            "flag": flag,
            "orphan": orphan,
            "summary": summary,
            "derived": derived,
            "reference": reference,
        }

    return notes


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

        site_rules = rules.for_site(site.slug)
        titles = [str(entry.get("title")) for entry in locations if entry.get("title")]
        # References that are report figures rather than site locations. They
        # are typed, never picked, so the second field offers back the ones
        # the rulebook already uses instead of asking for them from memory.
        benchmarks = sorted(
            {rule.reference_location for rule in site_rules} - set(titles)
        )
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
                "rules": site_rules,
                "locations": titles,
                "benchmarks": benchmarks,
                "rule_notes": build_rule_notes(site_rules, locations),
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

        # A saved formula is invisible until the next draft, which reads as
        # "nothing happened". Previewing it against the latest published price
        # shows immediately what the rule will do.
        preview = ""

        try:
            locations = client_for(site).locations().get("data", [])
            latest = next(
                (
                    entry.get("latest_price")
                    for entry in locations
                    if entry.get("title") == reference
                ),
                None,
            )

            if latest is not None:
                would_be = round(float(latest) * (1 + pct / 100.0))
                preview = (
                    f" Preview with today's prices: {reference} is {latest:g}, "
                    f"so {derived} would be {would_be}."
                )
        except SiteError:
            preview = ""

        return back(
            site.slug,
            "ok",
            f"Rule saved: {derived} = {reference} {pct:+g}%. It runs on every new fetch.{preview}",
        )

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
