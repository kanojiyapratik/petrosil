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
        site = site_or_404(slug)
        found = drafts.draft(draft_id, site.slug)

        if found is None:
            raise HTTPException(status_code=404, detail="That AI draft could not be found.")

        return jsonable(found)

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

    return router
