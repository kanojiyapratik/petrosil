"""The AI editorial update: the one screen where market reports become prices.

The owner's design: the console is the single place an editor works, for every
site. Reports are uploaded here; the site's current prices come in over its
API; the model drafts a per-location suggestion; the editor reviews the draft
here and stages the rows they keep back onto the site -- again over its API --
as a normal draft batch, committed from the existing batch screen. The site
gains no UI and the module still holds no site database credentials.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..db.store import Store, StoredSite
from ..editorial.extract import document_to_text
from ..editorial.review import ParsedSuggestions, build_rows, editorial_prompt, parse_suggestions
from .routes import tone_for
from .site_client import SiteClient, SiteError

MAX_DOCUMENTS = 5
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024


def create_editorial_routes(
    *,
    store: Store,
    templates: Jinja2Templates,
    current_user,
    driver,
    default_model: str,
    driver_for=None,
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

    def screen(request: Request, user, site: StoredSite, extra: dict, status: int = 200):
        context = {
            "user": user,
            "flash": None,
            "site": site,
            "section": "editorial",
            "crumbs": [
                {"label": site.name, "href": f"/console/sites/{site.slug}"},
                {"label": "Editorial update"},
            ],
            "tone_for": tone_for,
            "title": f"Editorial update · {site.name}",
            "today": date.today().isoformat(),
            "rows": None,
            "summary": None,
            "analysis": None,
            "pricedate": None,
            "error": None,
        }
        context.update(extra)

        return templates.TemplateResponse(request, "editorial.html", context, status_code=status)

    @router.get("/console/sites/{slug}/editorial", response_class=HTMLResponse)
    def form(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        return screen(request, user, site, {"error": request.query_params.get("err")})

    @router.post("/console/sites/{slug}/editorial", response_class=HTMLResponse)
    async def draft(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()
        uploads = [f for f in form_data.getlist("documents") if getattr(f, "filename", "")]

        if not uploads:
            return screen(request, user, site, {"error": "Choose at least one report file."}, 422)

        if len(uploads) > MAX_DOCUMENTS:
            return screen(
                request, user, site,
                {"error": f"At most {MAX_DOCUMENTS} documents per draft."}, 422,
            )

        texts = []

        for upload in uploads:
            raw = await upload.read()

            if len(raw) > MAX_DOCUMENT_BYTES:
                return screen(
                    request, user, site,
                    {"error": f"{upload.filename} is larger than 10 MB."}, 422,
                )

            text = document_to_text(upload.filename or "", raw)

            if text.strip():
                texts.append(text)

        if not texts:
            return screen(
                request, user, site,
                {"error": "No document could be read. Upload .docx, .xlsx, .pdf or .txt files."}, 422,
            )

        # The site's current prices, over its API -- the module reads no site
        # database. Without them there is nothing to compare against.
        try:
            locations = client_for(site).locations().get("data", [])
        except SiteError as error:
            return screen(request, user, site, {"error": str(error)}, 502)

        names = [str(entry.get("title") or "") for entry in locations if entry.get("title")]
        current = {
            str(entry["title"]): float(entry["latest_price"])
            for entry in locations
            if entry.get("title") and entry.get("latest_price") is not None
        }

        if not names:
            return screen(
                request, user, site,
                {"error": f"{site.name} reported no live locations to draft prices for."}, 502,
            )

        chosen = driver_for() if driver_for is not None else None
        active = chosen or driver
        model = getattr(chosen, "model", default_model) if chosen is not None else default_model

        try:
            prompt = editorial_prompt(names, texts)
            completion = (
                active.generate(prompt) if chosen is not None else active.generate(model, prompt)
            )
        except Exception as error:  # noqa: BLE001 - a provider failure is a screenful, not a 500
            return screen(request, user, site, {"error": str(error)}, 502)

        parsed = (
            parse_suggestions(completion.text, names)
            if completion.status == "complete"
            else ParsedSuggestions()
        )
        rows = build_rows(names, current, parsed)
        summary = {
            "total_locations": len(names),
            "suggested": sum(1 for row in rows if row["status"] == "suggested"),
            "no_evidence": sum(1 for row in rows if row["status"] == "no_evidence"),
            "invalid": sum(1 for row in rows if row["status"] == "invalid"),
            "flagged": sum(1 for row in rows if row["flag"] is not None),
            "dropped_unknown": parsed.dropped_unknown,
        }

        store.record(
            user.email,
            "drafted an editorial update",
            site.slug,
            f"{summary['suggested']} suggestion(s) from {len(uploads)} report(s)",
        )

        return screen(
            request, user, site,
            {
                "rows": rows,
                "summary": summary,
                "pricedate": pricedate,
                "analysis": {
                    "status": completion.status,
                    "model": model,
                    "error": completion.error,
                },
            },
        )

    @router.post("/console/sites/{slug}/editorial/stage")
    async def stage(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        path = f"/console/sites/{site.slug}/editorial"
        pricedate = str(form_data.get("pricedate") or "").strip()
        rows = []
        index = 0

        # One trio of fields per draft row: loc_N, price_N and the inc_N tick.
        while f"loc_{index}" in form_data:
            location = str(form_data.get(f"loc_{index}") or "").strip()
            price = str(form_data.get(f"price_{index}") or "").strip()
            included = form_data.get(f"inc_{index}") is not None

            index += 1

            if not included or not location or not price:
                continue

            try:
                rows.append({"location": location, "price": float(price)})
            except ValueError:
                continue

        if not rows:
            return RedirectResponse(
                f"{path}?err={quote('Tick at least one row with a price to stage.')}",
                status_code=303,
            )

        try:
            result = client_for(site).stage_rows(rows, price_date=pricedate, source="editorial")
        except SiteError as error:
            return RedirectResponse(f"{path}?err={quote(str(error))}", status_code=303)

        batch_id = result.get("batch", {}).get("id")
        store.record(
            user.email,
            "staged an editorial update",
            site.slug,
            f"{len(rows)} row(s) to batch #{batch_id}",
        )

        return RedirectResponse(
            f"/console/sites/{site.slug}/prices/{batch_id}"
            f"?ok={quote(f'Staged batch #{batch_id} with {len(rows)} row(s). Nothing is committed yet.')}",
            status_code=303,
        )

    return router
