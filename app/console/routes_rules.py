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

from ..db.store import RoundingStore, RulesStore, Store, StoredSite
from ..editorial.rules import FIXED, PERCENT, PriceRule, _adjusted, adjustment_label
from .config import ConsoleConfigError
from .access import make_site_guard
from .routes import tone_for
from .site_client import SiteClient, SiteError

# Typo catches for a fixed amount, per currency. Dollar and euro prices here
# run to four figures, so a five-figure difference is a slipped decimal
# point; rupee prices run to six figures and packed sits 11,800 over bulk.
FIXED_LIMITS = {"usd": 5000, "eur": 5000, "inr": 50000}

# What the unit dropdown shows for each currency, so a message can point at it.
_SHOWN_AS = {"USD": "US$", "EUR": "€", "INR": "₹"}


def _formula(rule) -> str:
    return f"{rule.reference_location} {adjustment_label(rule)}"


def _count(rules) -> str:
    return "1 rule" if len(rules) == 1 else f"{len(rules)} rules"


def _listed(rules, limit: int = 3) -> str:
    shown = [f"{rule.derived_location} {adjustment_label(rule)}" for rule in rules[:limit]]
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
                "This price already has a rule",
                f"Right now it comes from {_formula(rule)}. If you save, that is replaced.",
            )
        elif rule is not None:
            # create() rewrites the formula and never touches `enabled`, so a
            # replaced rule that was off stays off -- which reads as "nothing
            # happened" unless it is said here.
            summary += " (switched off)"
            derived = _note(
                "warn",
                "This price has a rule, but it is switched off",
                f"Right now it comes from {_formula(rule)}. If you save, that is replaced — "
                "and it stays switched off until you turn it on in the list below.",
            )
        elif used_by:
            # Rules chain to a fixpoint, so a rule here moves everything below it.
            derived = _note(
                "info",
                "Other prices are worked out from this one",
                f"{_listed(used_by)}. If you set a rule here, those prices change too.",
            )
        else:
            derived = _note(
                "mute",
                "No rule yet",
                "This price comes only from the market reports. This would be its first rule.",
            )

        # A reference is resolved by exact name. One that is neither a live
        # location nor a report figure matches nothing, so every rule hanging
        # off it silently never runs -- found on baseoil, where three Bright
        # Stock rules name a location that does not exist.
        orphan = bool(used_by) and name not in titles and not name.lower().startswith("report:")

        if orphan:
            reference = _note(
                "warn",
                "No price has this name",
                f"{count} already {'uses' if len(used_by) == 1 else 'use'} it — "
                f"{_listed(used_by)} — and none of them work, because there is no location "
                'called this. Correct the name, or write it as a report price starting with '
                '"Report:".',
            )
        elif used_by:
            detail = f"{_listed(used_by)}."

            if rule is not None:
                detail += (
                    f" And this price is itself worked out from {_formula(rule)}, so your "
                    "new rule follows on from that."
                )

            reference = _note(
                "info",
                f"{count} already {'comes' if len(used_by) == 1 else 'come'} from this price",
                detail,
            )
        elif rule is not None:
            reference = _note(
                "info",
                "This price is itself worked out from another",
                f"It comes from {_formula(rule)}. Your new rule follows on from that.",
            )
        else:
            reference = _note(
                "mute",
                "Nothing comes from this price yet",
                "Yours would be the first rule to use it.",
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
    rounding: RoundingStore | None = None,
) -> APIRouter:
    router = APIRouter()

    def client_for(site: StoredSite) -> SiteClient:
        if client_factory is not None:
            return client_factory(site)

        return SiteClient(base_url=site.api_url, token=site.token, name=site.name)

    # Returns (user, site, a-response-to-send-instead). The one implementation
    # lives in access.py, so a site the signed-in user has not been given
    # answers the same 404 here as it does on every other screen.
    guard = make_site_guard(store=store, templates=templates, current_user=current_user)

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
        # The last published price of each location, so the screen can do the
        # sum in front of the person setting it up: an explanation of what a
        # percentage or a dollar difference means is worth far less than
        # "Singapore is 1560 today, so this would be 1535".
        prices = {
            str(entry["title"]): float(entry["latest_price"])
            for entry in locations
            if entry.get("title") and entry.get("latest_price") is not None
        }
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
                "label": adjustment_label,
                "locations": titles,
                "benchmarks": benchmarks,
                "prices": prices,
                "currencies": {
                    str(entry["title"]): str(entry["currency"])
                    for entry in locations
                    if entry.get("title") and entry.get("currency")
                },
                "rule_notes": build_rule_notes(site_rules, locations),
                "round_to_nearest": site.round_to_nearest,
                "rounding_overrides": rounding.list_for_site(site.slug) if rounding else [],
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
        raw_value = str(form.get("adjustment_value") or "").strip()
        raw_kind = str(form.get("adjustment_kind") or "")
        kind = raw_kind if raw_kind in FIXED else PERCENT

        if not derived or not reference:
            return back(site.slug, "err", "Pick both locations.")

        if derived == reference:
            return back(site.slug, "err", "A price cannot be calculated from itself.")

        try:
            amount = float(raw_value)
        except ValueError:
            return back(
                site.slug,
                "err",
                "Type a number — for example -10 for 10% less, or -25 for 25 less in the "
                "price's own currency.",
            )

        # -100 is the real floor: at it, and below it, the price is nothing or
        # less. The old -95 was tighter than the arithmetic needs and refused
        # the one rule the client actually has down there -- a conversion at a
        # fixed rate, which is a large negative percentage (dividing by 29 is
        # -96.5517%). A price that still rounds to nothing is dropped by the
        # engine, so the floor is the only guard this needs. Both bounds stay
        # typo catches -- prices here run to four figures, so a five-figure
        # difference is a slipped decimal point, not a rule.
        if kind == PERCENT and not -100 < amount <= 1000:
            return back(
                site.slug,
                "err",
                "A percentage must be more than -100 (a price cannot fall below "
                "nothing) and at most +1,000.",
            )

        # Rupee prices run to six figures (packed over bulk is 11,800), so the
        # typo catch there is ten times the dollar and euro one.
        limit = FIXED_LIMITS.get(kind)

        if limit is not None and not -limit <= amount <= limit:
            return back(
                site.slug,
                "err",
                f"A fixed difference in {FIXED[kind]} must be between -{limit:,} and +{limit:,}.",
            )

        try:
            locations = client_for(site).locations().get("data", [])
        except SiteError:
            locations = None

        # A fixed amount is added to the price as it stands, and the site
        # stores the result in the derived location's own currency -- so "+5
        # US dollars" on a euro price would be published as five euros. When
        # the site says what currency the price is in, the amount must match.
        if kind in FIXED and locations is not None:
            priced_in = next(
                (
                    str(entry.get("currency") or "").upper()
                    for entry in locations
                    if entry.get("title") == derived and entry.get("currency")
                ),
                None,
            )

            if priced_in and priced_in != FIXED[kind]:
                return back(
                    site.slug,
                    "err",
                    f"{derived} is priced in {priced_in}, so a fixed amount for it has to be "
                    f"in {priced_in} too. Pick {_SHOWN_AS.get(priced_in, priced_in)} next to "
                    "the amount.",
                )

        saved = PriceRule(
            id=0,
            derived_location=derived,
            reference_location=reference,
            adjustment_value=amount,
            adjustment_kind=kind,
        )
        rules.create(site.slug, derived, reference, amount, kind)
        store.record(
            user.email,
            "set a price rule",
            site.slug,
            f"{derived} = {reference} {adjustment_label(saved)}",
        )

        # A saved formula is invisible until the next draft, which reads as
        # "nothing happened". Previewing it against the latest published price
        # shows immediately what the rule will do.
        preview = ""
        latest = next(
            (
                entry.get("latest_price")
                for entry in (locations or [])
                if entry.get("title") == reference
            ),
            None,
        )

        if latest is not None:
            would_be = round(_adjusted(float(latest), saved))
            preview = (
                f" With today's prices: {reference} is {latest:g}, "
                f"so {derived} would be {would_be}."
            )

        return back(
            site.slug,
            "ok",
            f"Saved. {derived} now comes from {reference} {adjustment_label(saved)}. It is "
            f"used the next time prices are fetched.{preview}",
        )

    @router.post("/console/sites/{slug}/rules/{rule_id}/toggle")
    async def toggle_rule(request: Request, slug: str, rule_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        enabled = str(form.get("enabled") or "") == "1"

        # The rule has to be this site's own. The id comes off the address
        # bar and the ids are small and sequential, so being allowed to use
        # one site would otherwise be enough to turn off another site's
        # rules -- and the trail would name this site for it.
        if not rules.set_enabled(site.slug, rule_id, enabled):
            return back(site.slug, "err", "No such rule.")

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

        if not rules.delete(site.slug, rule_id):
            return back(site.slug, "err", "No such rule.")

        store.record(user.email, "removed a price rule", site.slug, f"rule #{rule_id}")

        return back(site.slug, "ok", "Rule removed.")

    def _parse_step(raw: str) -> float | None:
        """Blank clears the step; anything else must be a plain positive
        number -- the same "0 or blank means no rounding" rule rounding.py
        itself applies, so a bad value here is refused rather than silently
        turning rounding off."""
        raw = raw.strip()

        if raw == "":
            return None

        try:
            value = float(raw)
        except ValueError as error:
            raise ConsoleConfigError(
                "Type a plain number to round to — for example 5 — or leave it blank for no "
                "rounding."
            ) from error

        if value <= 0:
            raise ConsoleConfigError("A rounding step must be greater than zero.")

        return value

    if rounding is not None:

        @router.post("/console/sites/{slug}/rounding")
        async def set_default_rounding(request: Request, slug: str):
            """The site-wide step -- what bitumart sets to 5. Read/checked
            prices, FX conversions and rule-derived prices all round to this
            once they reach the editorial screen; see
            app/editorial/rounding.py."""
            user, site, response = guard(request, slug)

            if response is not None:
                return response

            form = await request.form()

            try:
                step = _parse_step(str(form.get("round_to_nearest") or ""))
            except ConsoleConfigError as error:
                return back(site.slug, "err", str(error))

            store.set_round_to_nearest(site.slug, step)
            store.record(
                user.email,
                "set the site's rounding step",
                site.slug,
                f"round to nearest {step}" if step else "no rounding",
            )

            return back(
                site.slug, "ok",
                f"Prices now round to the nearest {step}." if step
                else "Rounding turned off — prices are used exactly as worked out.",
            )

        @router.post("/console/sites/{slug}/rounding/override")
        async def add_rounding_override(request: Request, slug: str):
            """A location that rounds differently from the site default --
            Turkey's own-currency price, to the nearest 10."""
            user, site, response = guard(request, slug)

            if response is not None:
                return response

            form = await request.form()
            location = str(form.get("location") or "").strip()

            if not location:
                return back(site.slug, "err", "Pick a location.")

            try:
                step = _parse_step(str(form.get("round_to_nearest") or ""))
            except ConsoleConfigError as error:
                return back(site.slug, "err", str(error))

            if step is None:
                return back(
                    site.slug, "err",
                    "Type a rounding step for this location, or remove it from the list below "
                    "instead.",
                )

            rounding.set_override(site.slug, location, step)
            store.record(
                user.email, "set a location's rounding step", site.slug,
                f"{location} rounds to the nearest {step}",
            )

            return back(site.slug, "ok", f"{location} now rounds to the nearest {step}.")

        @router.post("/console/sites/{slug}/rounding/override/{override_id}/delete")
        async def delete_rounding_override(request: Request, slug: str, override_id: int):
            user, site, response = guard(request, slug)

            if response is not None:
                return response

            if not rounding.delete(site.slug, override_id):
                return back(site.slug, "err", "No such rounding step.")

            store.record(
                user.email, "removed a location's rounding step", site.slug,
                f"override #{override_id}",
            )

            return back(site.slug, "ok", "Removed. This location now uses the site default.")

    return router
