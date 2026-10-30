"""The engine's JSON face, for the app's AI tools tab.

The app draws the screens; the engine does the work. Every route here runs
the same step the console's own screens run (flows.py), so the two cannot
drift apart while both exist.

Who may call: only the app, with the engine's API token. The app has already
decided the person may use this brand's AI tools -- the engine holds no
users of its own for this path -- and names them in `X-Acting-User`, so the
engine's audit trail still says who read, drafted and saved.

Errors come back as {"error": "<words for the editor>"} with the status the
console has always used; a used reading also carries "reuse".
"""

from __future__ import annotations

import dataclasses
import hmac
import re
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from scraper.pdf import pdf_needs_password

from ..editorial.extract import document_images, document_to_text
from ..editorial.preflight import preflight
from ..editorial.rules import adjustment_label
from .flows import (
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENTS,
    Engine,
    FlowError,
    check_row_fields,
    draft_prices,
    grouped_files,
    read_reports,
    save_draft,
    workings_sheet,
    write_update_note,
)
from .crawl_now import crawl_site_now, describe, propose_matches
from .routes_ai import (
    add_provider,
    assign_site_model,
    make_default_provider,
    models_for_new_key,
    providers_view,
    remove_provider,
    site_ai_view,
    test_provider,
    update_provider,
)
from .routes_rules import (
    remove_location_rounding,
    remove_rule,
    rules_overview,
    save_rule,
    set_location_rounding,
    set_site_rounding,
    switch_rule,
)
from .site_client import SiteClient

ACTOR_MAX = 191


def jsonable(value):
    """Dataclasses, dates and NUMERIC values in a shape JSON can carry."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {key: jsonable(item) for key, item in dataclasses.asdict(value).items()}

    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}

    if isinstance(value, (list, tuple, set)):
        return [jsonable(item) for item in value]

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    if isinstance(value, Decimal):
        return float(value)

    return value


def refusal(error: FlowError) -> JSONResponse:
    body = {"error": error.message}

    if error.reuse is not None:
        body["reuse"] = error.reuse

    return JSONResponse(body, status_code=error.status)


def _as_form(body: dict) -> dict:
    """A JSON row as the console's form would have posted it: every value a
    string, and "kept" present only when it is ticked -- so check_row_fields
    holds a typed row to exactly the rules a posted one meets."""
    form = {
        key: ("" if value is None else str(value))
        for key, value in body.items()
        if key != "kept"
    }

    if body.get("kept"):
        form["kept"] = "1"

    return form


def create_engine_api(
    *,
    api_token: str,
    store,
    extractions,
    drafts,
    driver,
    default_model: str,
    driver_for=None,
    usage=None,
    rules=None,
    fx=None,
    rounding=None,
    providers=None,
    client_factory=None,
) -> APIRouter:
    engine = Engine(
        store=store, extractions=extractions, driver=driver, default_model=default_model,
        driver_for=driver_for, usage=usage, rules=rules, fx=fx, rounding=rounding, drafts=drafts,
    )

    def client_for(site) -> SiteClient:
        if client_factory is not None:
            return client_factory(site)

        return SiteClient(base_url=site.api_url, token=site.token, name=site.name)

    def caller(
        authorization: str | None = Header(default=None),
        x_acting_user: str | None = Header(default=None),
    ) -> str:
        """The app, and the person it is acting for.

        Fails closed like /api/*: no configured token rejects everything.
        """
        provided = re.sub(r"^Bearer\s+", "", authorization or "", flags=re.IGNORECASE)

        if api_token == "" or provided == "" or not hmac.compare_digest(provided, api_token):
            raise HTTPException(status_code=401, detail="Unauthenticated.")

        actor = (x_acting_user or "").strip()

        # Every step writes the audit trail in this person's name; a step
        # nobody can be named for is not taken.
        if not actor or len(actor) > ACTOR_MAX:
            raise HTTPException(status_code=400, detail="Say who is acting (X-Acting-User).")

        return actor

    def site_or_404(slug: str):
        site = store.site_by_slug(slug)

        if site is None or not site.enabled:
            raise HTTPException(status_code=404, detail="No such site.")

        return site

    def reading_or_404(site, set_id: int):
        reading = extractions.set_by_id(set_id)

        # The set must belong to this site, exactly as on the console.
        if reading is None or reading.site_slug != site.slug:
            raise HTTPException(status_code=404, detail="That set of reports could not be found.")

        return reading

    def reading_view(reading) -> dict:
        rows = extractions.rows_for(reading.id)

        return {
            "id": reading.id,
            "created_by": reading.created_by,
            "created_at": jsonable(reading.created_at),
            "used_at": jsonable(reading.used_at),
            "files": jsonable(grouped_files(reading, rows)),
        }

    router = APIRouter(prefix="/api/engine/sites/{slug}")

    # ------------------------------------------------------------- the screen

    @router.get("/editorial")
    def overview(slug: str, actor: str = Depends(caller)):
        """What the AI price update tab opens with: the saved instructions,
        the limits, a reading left waiting, and the last one used."""
        site = site_or_404(slug)
        waiting = extractions.latest_open(site.slug)
        spent = extractions.latest_used(site.slug) if waiting is None else None

        return {
            "site": {
                "slug": site.slug,
                "name": site.name,
                "instructions": site.editorial_instructions,
                "round_to_nearest": jsonable(site.round_to_nearest),
                "round_direction": site.round_direction,
            },
            "limits": {"documents": MAX_DOCUMENTS, "bytes": MAX_DOCUMENT_BYTES},
            "waiting": reading_view(waiting) if waiting is not None else None,
            "spent": (
                {
                    "id": spent.id,
                    "used_at": jsonable(spent.used_at),
                    "draft_id": drafts.latest_for_reading(site.slug, spent.id) if drafts is not None else None,
                }
                if spent is not None
                else None
            ),
        }

    @router.put("/instructions")
    async def save_instructions(slug: str, request: Request, actor: str = Depends(caller)):
        """The editor's saved-per-site instructions. Blank clears them."""
        site = site_or_404(slug)
        body = await request.json()
        instructions = str(body.get("instructions") or "").strip()

        if instructions != (site.editorial_instructions or ""):
            store.set_editorial_instructions(site.slug, instructions)
            store.record(actor, "saved the AI instructions", site.slug, f"{len(instructions)} characters")

        return {"instructions": instructions or None}

    # --------------------------------------------------------------- reading

    @router.post("/readings")
    async def read(slug: str, request: Request, actor: str = Depends(caller)):
        """Step one. Multipart: `documents` (1-5 files, 10 MB each) and,
        when this run should follow instructions, `instructions` -- the text
        for this run only; saving is a separate call."""
        site = site_or_404(slug)
        form_data = await request.form()
        uploads = [f for f in form_data.getlist("documents") if getattr(f, "filename", "")]
        instructions = str(form_data.get("instructions") or "").strip() or None

        if not uploads:
            return JSONResponse({"error": "Choose at least one report."}, status_code=422)

        if len(uploads) > MAX_DOCUMENTS:
            return JSONResponse({"error": f"At most {MAX_DOCUMENTS} reports at a time."}, status_code=422)

        bodies = []

        for upload in uploads:
            raw = await upload.read()

            if len(raw) > MAX_DOCUMENT_BYTES:
                return JSONResponse({"error": f"{upload.filename} is larger than 10 MB."}, status_code=422)

            bodies.append((upload.filename or "report", raw))

        result = read_reports(
            engine, site, actor, bodies, instructions,
            document_to_text=document_to_text,
            document_images=document_images,
            pdf_needs_password=pdf_needs_password,
        )

        return JSONResponse(
            {"reading": reading_view(result.reading), "failures": result.failures},
            status_code=201,
        )

    @router.get("/readings/{set_id}")
    def reading(slug: str, set_id: int, actor: str = Depends(caller)):
        site = site_or_404(slug)

        return reading_view(reading_or_404(site, set_id))

    @router.patch("/readings/{set_id}/rows/{row_id}")
    async def edit_row(slug: str, set_id: int, row_id: int, request: Request, actor: str = Depends(caller)):
        """Correct a figure, fix a name, drop a row (kept: false)."""
        site = site_or_404(slug)
        reading = reading_or_404(site, set_id)
        row = next((r for r in extractions.rows_for(set_id) if r.id == row_id), None)

        if row is None or row.set_id != reading.id:
            raise HTTPException(status_code=404, detail="That row is not in this reading.")

        fields, complaint = check_row_fields(_as_form(await request.json()))

        if complaint is not None:
            return JSONResponse({"error": complaint}, status_code=422)

        extractions.update_row(row_id, **fields)

        return reading_view(reading)

    @router.post("/readings/{set_id}/rows")
    async def add_row(slug: str, set_id: int, request: Request, actor: str = Depends(caller)):
        """Add a price the model missed, under one of this reading's files
        (`file_id`, or `filename` for a file from before files had ids)."""
        site = site_or_404(slug)
        reading = reading_or_404(site, set_id)
        body = await request.json()
        panels = grouped_files(reading, extractions.rows_for(set_id))
        file_id = body.get("file_id") if isinstance(body.get("file_id"), int) else None
        panel = next((p for p in panels if file_id is not None and p.get("id") == file_id), None)
        filename = panel["filename"] if panel is not None else str(body.get("filename") or "").strip()

        if panel is None and filename not in {p["filename"] for p in panels}:
            return JSONResponse({"error": "That price could not be added to any of these reports."}, status_code=422)

        fields, complaint = check_row_fields(_as_form({k: v for k, v in body.items() if k not in ("file_id", "filename")}))

        if complaint is not None:
            return JSONResponse({"error": complaint}, status_code=422)

        extractions.add_row(set_id, filename, fields, file_id=file_id)
        store.record(actor, "added a price", site.slug, f"{fields['name']} in {filename}")

        return JSONResponse(reading_view(reading), status_code=201)

    # -------------------------------------------------------------- drafting

    @router.post("/drafts")
    async def draft(slug: str, request: Request, actor: str = Depends(caller)):
        """Step two: {set_id, pricedate, again?, used_at?}. Takes as long as
        the model does -- three passes; tens of seconds to a few minutes."""
        site = site_or_404(slug)
        body = await request.json()

        try:
            set_id = int(body.get("set_id"))
        except (TypeError, ValueError):
            return JSONResponse({"error": "That reading could not be found."}, status_code=404)

        pricedate = str(body.get("pricedate") or "").strip() or date.today().isoformat()

        try:
            result = draft_prices(
                engine, site, actor, client_for(site),
                set_id=set_id,
                pricedate=pricedate,
                again=bool(body.get("again")),
                held=str(body.get("used_at") or ""),
            )
        except FlowError as refused:
            return refusal(refused)

        return JSONResponse(jsonable(result), status_code=201)

    @router.get("/drafts")
    def drafts_list(slug: str, limit: int = 20, actor: str = Depends(caller)):
        site = site_or_404(slug)

        return {"drafts": jsonable(drafts.recent(site.slug, limit))}

    @router.get("/drafts/{draft_id}")
    def draft_view(slug: str, draft_id: int, actor: str = Depends(caller)):
        """A kept draft, with the preflight checks run again over it.

        The checks are not stored with a draft, and a draft page has to be
        able to reload. Every row keeps the whole dict the checks were first
        run on (`detail`), so they are run on that again -- against the
        brand's rules and rounding as they are now, which is what saving it
        today would be judged by.
        """
        site = site_or_404(slug)
        found = drafts.draft(draft_id, site.slug)

        if found is None:
            raise HTTPException(status_code=404, detail="That AI draft could not be found.")

        sheet = [row.detail for row in found.rows if row.detail]
        findings = (
            preflight(
                sheet,
                rules=rules.for_site(site.slug) if rules is not None else [],
                default_step=(site.round_to_nearest, site.round_direction),
                overrides=rounding.for_site(site.slug) if rounding is not None else None,
                price_date=found.price_date,
            )
            if sheet
            else []
        )

        return {
            "draft": jsonable(found),
            "findings": jsonable(findings),
            "blockers": sum(1 for finding in findings if finding.severity == "blocker"),
        }

    @router.post("/drafts/{draft_id}/save")
    async def save(slug: str, draft_id: int, request: Request, actor: str = Depends(caller)):
        """Step three: {pricedate, rows: [{location, price, calculation?}]} --
        only the rows the editor kept, at the price they settled on. Becomes
        a draft price update on the site; nothing is published."""
        site = site_or_404(slug)
        body = await request.json()

        if drafts.draft(draft_id, site.slug) is None:
            raise HTTPException(status_code=404, detail="That AI draft could not be found.")

        rows, derivations = [], []

        for entry in body.get("rows") or []:
            location = str(entry.get("location") or "").strip()

            try:
                price = float(entry.get("price"))
            except (TypeError, ValueError):
                continue

            if not location:
                continue

            rows.append({"location": location, "price": price})
            calculation = str(entry.get("calculation") or "").strip()

            if calculation:
                derivations.append(f"{location} = {entry.get('price')}: {calculation}")

        try:
            batch_id, saved = save_draft(
                engine, site, actor, client_for(site),
                rows=rows, derivations=derivations,
                pricedate=str(body.get("pricedate") or "").strip(),
                draft_id=draft_id,
            )
        except FlowError as refused:
            return refusal(refused)

        return JSONResponse({"batch_id": batch_id, "saved": saved}, status_code=201)

    # ------------------------------------------------- the rulebook and rounding

    def said(step, status: int = 200) -> JSONResponse:
        """Run one rulebook step: its message, or the console's refusal."""
        try:
            return JSONResponse({"message": step()}, status_code=status)
        except FlowError as refused:
            return refusal(refused)

    @router.get("/rules")
    def rulebook(slug: str, actor: str = Depends(caller)):
        """The rules, the rounding, and what each location is priced at and in."""
        site = site_or_404(slug)
        view = rules_overview(site, rules=rules, rounding=rounding, client=client_for(site))

        return {
            **jsonable(view),
            "rules": [{**jsonable(rule), "label": adjustment_label(rule)} for rule in view["rules"]],
        }

    @router.post("/rules")
    async def add_rule(slug: str, request: Request, actor: str = Depends(caller)):
        """{derived, reference, value, kind}: add a rule, or replace the one the
        derived location has. kind is "percent", "usd", "eur" or "inr"."""
        site = site_or_404(slug)
        body = await request.json()

        return said(
            lambda: save_rule(
                site, actor, rules=rules, store=store, client=client_for(site),
                derived=str(body.get("derived") or ""),
                reference=str(body.get("reference") or ""),
                raw_value=str(body.get("value") if body.get("value") is not None else ""),
                raw_kind=str(body.get("kind") or ""),
            ),
            201,
        )

    @router.patch("/rules/{rule_id}")
    async def turn_rule(slug: str, rule_id: int, request: Request, actor: str = Depends(caller)):
        site = site_or_404(slug)
        body = await request.json()

        return said(lambda: switch_rule(site, actor, rule_id, bool(body.get("enabled")), rules=rules, store=store))

    @router.delete("/rules/{rule_id}")
    def drop_rule(slug: str, rule_id: int, actor: str = Depends(caller)):
        site = site_or_404(slug)

        return said(lambda: remove_rule(site, actor, rule_id, rules=rules, store=store))

    @router.put("/rounding")
    async def site_rounding(slug: str, request: Request, actor: str = Depends(caller)):
        """{step, direction}: the site-wide step; blank step turns rounding off."""
        site = site_or_404(slug)
        body = await request.json()

        return said(
            lambda: set_site_rounding(
                site, actor, store=store,
                raw_step=str(body.get("step") if body.get("step") is not None else ""),
                raw_direction=str(body.get("direction") or ""),
            )
        )

    @router.post("/rounding/locations")
    async def location_rounding(slug: str, request: Request, actor: str = Depends(caller)):
        """{location, step, direction, exact, as_printed}: one location's own
        rounding; exact means never rounded."""
        site = site_or_404(slug)
        body = await request.json()

        return said(
            lambda: set_location_rounding(
                site, actor, rounding=rounding, store=store, client=client_for(site),
                location=str(body.get("location") or ""),
                exact=bool(body.get("exact")),
                as_printed=bool(body.get("as_printed")),
                raw_step=str(body.get("step") if body.get("step") is not None else ""),
                raw_direction=str(body.get("direction") or ""),
            ),
            201,
        )

    @router.delete("/rounding/locations/{override_id}")
    def drop_location_rounding(slug: str, override_id: int, actor: str = Depends(caller)):
        site = site_or_404(slug)

        return said(lambda: remove_location_rounding(site, actor, override_id, rounding=rounding, store=store))

    # ------------------------------------------------------------ AI settings

    @router.get("/ai-settings")
    def ai_settings(slug: str, actor: str = Depends(caller)):
        """This site's model, the providers it may choose from (never their
        keys), and its saved instructions."""
        site = site_or_404(slug)

        if providers is None:
            raise HTTPException(status_code=404, detail="AI settings are not available here.")

        return {**site_ai_view(site.slug, providers=providers), "instructions": site.editorial_instructions}

    @router.put("/ai-settings")
    async def choose_model(slug: str, request: Request, actor: str = Depends(caller)):
        """{provider_id, model}: blank provider means the default."""
        site = site_or_404(slug)
        body = await request.json()

        if providers is None:
            raise HTTPException(status_code=404, detail="AI settings are not available here.")

        return said(
            lambda: assign_site_model(
                site, actor, providers=providers, store=store,
                raw_provider_id=str(body.get("provider_id") or ""),
                raw_model=str(body.get("model") or ""),
            )
        )

    # ---------------------------------------------------------- after a commit

    @router.post("/batches/{batch_id}/note")
    def note(slug: str, batch_id: int, actor: str = Depends(caller)):
        """The app committed a price update: write the note above the
        brand's price table, as the console does after its own commits.
        Best-effort, like there -- the prices are already live."""
        site = site_or_404(slug)
        write_update_note(
            client_for(site), batch_id,
            driver=driver, default_model=default_model, driver_for=driver_for, site_slug=site.slug,
        )
        store.record(actor, "asked for the price note", site.slug, f"batch #{batch_id}")

        return JSONResponse({}, status_code=202)

    @router.get("/drafts/{draft_id}/workings.csv")
    def workings(slug: str, draft_id: int, actor: str = Depends(caller)):
        """The draft as the sheet that argues for itself -- the same export
        as the console's."""
        site = site_or_404(slug)
        found = drafts.draft(draft_id, site.slug)

        if found is None:
            raise HTTPException(status_code=404, detail="That AI draft could not be found.")

        return Response(
            content=workings_sheet(found),
            media_type="text/csv; charset=utf-8",
            headers={
                "content-disposition": f'attachment; filename="{site.slug}-{found.price_date or found.id}-workings.csv"'
            },
        )

    # --------------------------------------------------------------- crawling

    @router.post("/crawl")
    def crawl(slug: str, actor: str = Depends(caller)):
        """One pass over the site's watched pages now, rather than at the next
        fifteen-minute tick. Runs while the caller waits -- seconds when the
        pages have not changed -- and answers in a sentence."""
        site = site_or_404(slug)

        try:
            outcomes = crawl_site_now(site, providers=providers)
        except Exception as error:  # noqa: BLE001 - said, never a 500
            return JSONResponse({"error": str(error)}, status_code=502)

        store.record(actor, "ran a crawl by hand", site.slug, f"{len(outcomes)} URL(s)")

        return {
            "message": describe(outcomes),
            "outcomes": [
                {"url": o.url, "status": o.status, "rows": o.row_count, "used_ai": o.used_ai} for o in outcomes
            ],
        }

    @router.post("/crawl/matches")
    async def crawl_matches(slug: str, request: Request, actor: str = Depends(caller)):
        """{findings: [{id, location, price}]}: for crawled prices the site has
        no location for, which of its locations each probably is, and why to
        be careful. A proposal only; the person picks."""
        site = site_or_404(slug)
        body = await request.json()
        findings = [
            {"id": int(row["id"]), "location": row.get("location"), "price": row.get("price")}
            for row in body.get("findings") or []
            if isinstance(row, dict) and str(row.get("id", "")).isdigit()
        ]

        try:
            titles = [str(e.get("title")) for e in client_for(site).locations().get("data", []) if e.get("title")]
        except Exception:  # noqa: BLE001 - no titles, no proposals
            titles = []

        active, chosen, model, _ = engine.model_for(site.slug)
        proposals = propose_matches(
            findings, titles, active=active, chosen=chosen, model=model, usage=usage, site_slug=site.slug
        )

        return {"proposals": {str(key): value for key, value in proposals.items()}}

    # -------------------------------------------- the estate: providers, usage

    estate = APIRouter(prefix="/api/engine")

    def needs_providers():
        if providers is None:
            raise HTTPException(status_code=404, detail="AI settings are not available here.")

    @estate.get("/providers")
    def provider_list(actor: str = Depends(caller)):
        """Every provider, its key masked, what it can run, who uses it."""
        needs_providers()

        return providers_view(providers=providers)

    @estate.post("/providers/check-key")
    async def provider_check_key(request: Request, actor: str = Depends(caller)):
        """{provider, api_key}: what a key being typed in can run. Never kept."""
        needs_providers()
        body = await request.json()

        try:
            return {"models": models_for_new_key(body.get("provider"), body.get("api_key"))}
        except FlowError as refused:
            return refusal(refused)

    @estate.post("/providers")
    async def provider_add(request: Request, actor: str = Depends(caller)):
        """{provider, api_key, name?, make_default?}"""
        needs_providers()
        body = await request.json()

        return said(
            lambda: add_provider(
                actor, providers=providers, store=store,
                provider=str(body.get("provider") or ""),
                raw_key=body.get("api_key"),
                name=str(body.get("name") or ""),
                make_default=bool(body.get("make_default")),
            ),
            201,
        )

    @estate.patch("/providers/{provider_id}")
    async def provider_update(provider_id: int, request: Request, actor: str = Depends(caller)):
        """{name?, model?, api_key? (blank keeps the stored one), enabled}"""
        needs_providers()
        body = await request.json()

        return said(
            lambda: update_provider(
                actor, provider_id, providers=providers, store=store,
                name=str(body.get("name") or ""),
                model=str(body.get("model") or ""),
                raw_key=body.get("api_key"),
                enabled=body.get("enabled", True) is not False,
            )
        )

    @estate.post("/providers/{provider_id}/default")
    def provider_default(provider_id: int, actor: str = Depends(caller)):
        needs_providers()

        return said(lambda: make_default_provider(actor, provider_id, providers=providers, store=store))

    @estate.delete("/providers/{provider_id}")
    def provider_remove(provider_id: int, actor: str = Depends(caller)):
        needs_providers()

        return said(lambda: remove_provider(actor, provider_id, providers=providers, store=store))

    @estate.post("/providers/{provider_id}/test")
    def provider_test(provider_id: int, actor: str = Depends(caller)):
        """One tiny call, to tell a wrong key, a wrong model and an empty
        quota apart before they surface in a price update."""
        needs_providers()

        return said(lambda: test_provider(provider_id, providers=providers, usage=usage))

    @estate.get("/usage")
    def usage_report(days: int = 30, actor: str = Depends(caller)):
        """Model calls and tokens: per day and model, and per site and kind
        of work, over the last `days` (1-365)."""
        span = max(1, min(int(days), 365))

        if usage is None:
            return {"days": span, "by_day": [], "by_site": []}

        return {"days": span, "by_day": jsonable(usage.by_day(span)), "by_site": usage.by_site(span)}

    combined = APIRouter()
    combined.include_router(router)
    combined.include_router(estate)

    return combined
