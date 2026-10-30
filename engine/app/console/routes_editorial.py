"""The AI editorial update: the one screen where market reports become prices.

The owner's design: the console is the single place an editor works, for every
site. Reports are uploaded here; the site's current prices come in over its
API; the model drafts a per-location suggestion; the editor reviews the draft
here and stages the rows they keep back onto the site -- again over its API --
as a normal draft batch, committed from the existing batch screen. The site
gains no UI and the module still holds no site database credentials.

The drafting and saving themselves are in flows.py, shared with the app's AI
tools tab; this module is the console's screens around them.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates

from ..db.store import Store, StoredSite
from .access import make_site_guard
from .flows import (  # noqa: F401 - MAX_* and money_sign are imported from here too
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENTS,
    Engine,
    FlowError,
    draft_prices,
    money_sign,
    save_draft,
    workings_sheet,
)
from .routes import tone_for
from .site_client import SiteClient, SiteError


def _price(value) -> str:
    """A stored price for reading: 1,560 not 1560.0, 537.50 not 537.5."""
    if value is None:
        return "—"

    value = float(value)

    return f"{value:,.0f}" if value == int(value) else f"{value:,.2f}"


def create_editorial_routes(
    *,
    store: Store,
    templates: Jinja2Templates,
    current_user,
    driver,
    default_model: str,
    driver_for=None,
    client_factory=None,
    usage=None,
    rules=None,
    fx=None,
    extractions=None,
    rounding=None,
    drafts=None,
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
            "batches": None,
            "benchmarks": None,
            # Set only on the 409: the reading whose figures may be used again.
            "reuse": None,
            # The kept copy of this draft (DraftStore), so saving links back to it.
            "draft_id": None,
            # What the sheet says about itself. See app/editorial/preflight.py.
            "findings": None,
            "blockers": 0,
            "instructions_used": None,
            # A reading already read and not yet used, so a closed tab does
            # not strand it. See ExtractionStore.latest_open.
            "waiting": None,
            # A reading already used, whose draft may have been lost with it.
            "spent": None,
            # The saved per-site instructions prefill the form; after a draft
            # the just-typed text wins, so an edit is never silently reverted.
            "instructions": site.editorial_instructions,
            # The upload panel's accumulating-list enhancement reads its own
            # limits from here rather than a second hardcoded 5 and 10.
            "max_documents": MAX_DOCUMENTS,
            "max_document_bytes": MAX_DOCUMENT_BYTES,
            "max_document_mb": MAX_DOCUMENT_BYTES // (1024 * 1024),
        }
        context.update(extra)

        return templates.TemplateResponse(request, "editorial.html", context, status_code=status)

    @router.get("/console/sites/{slug}/editorial", response_class=HTMLResponse)
    def form(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        # The batch list lives here since "Update prices" left the menu: a
        # staged draft must stay findable, or committing needs a bookmark. A
        # site that cannot answer costs the list, not the screen.
        try:
            batches = client_for(site).batches().get("data", [])
        except SiteError:
            batches = []

        flash = None

        if request.query_params.get("ok"):
            flash = {"kind": "ok", "text": request.query_params["ok"]}

        # A reading that has been paid for and not yet used must stay
        # reachable: the only other way back to one is the 303 straight after
        # the upload, so closing the tab lost four read reports.
        # A reading that was used and then lost -- staging failed, or the tab
        # was closed -- is not waiting, but it is still the only copy of the
        # editor's checked figures, and opening it leads to the "Use these
        # prices again" button. So it is offered too, saying plainly that it
        # has been used once.
        waiting = None
        spent = None

        if extractions is not None:
            try:
                waiting = extractions.latest_open(site.slug)

                if waiting is None:
                    spent = extractions.latest_used(site.slug)
            except Exception:  # noqa: BLE001 - a missing reminder is not a broken screen
                waiting, spent = None, None

        # Which price updates came from an AI draft, for the "View draft"
        # column; and the draft a used reading made, which may never have
        # been saved and so has no price update to be found from.
        draft_links: dict[int, int] = {}
        spent_draft_id = None

        if drafts is not None:
            try:
                draft_links = drafts.ids_for_batches(
                    site.slug, [int(batch["id"]) for batch in batches if batch.get("id")]
                )

                if spent is not None:
                    spent_draft_id = drafts.latest_for_reading(site.slug, spent.id)
            except Exception:  # noqa: BLE001 - a missing link is not a broken screen
                draft_links, spent_draft_id = {}, None

        return screen(
            request, user, site,
            {
                "error": request.query_params.get("err"),
                "flash": flash,
                "waiting": waiting,
                "spent": spent,
                "spent_draft_id": spent_draft_id,
                "batches": [
                    {
                        **batch,
                        "tone": tone_for(batch.get("status")),
                        "draft_id": draft_links.get(int(batch["id"])) if batch.get("id") else None,
                    }
                    for batch in batches
                ],
            },
        )

    @router.get("/console/sites/{slug}/editorial/drafts/{draft_id}", response_class=HTMLResponse)
    def view_draft(request: Request, slug: str, draft_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        draft = drafts.draft(draft_id, site.slug) if drafts is not None else None

        if draft is None:
            return screen(
                request, user, site, {"error": "That AI draft could not be found."}, 404
            )

        rows = [row for row in draft.rows if not row.is_benchmark]
        saved = draft.batch_id is not None
        kept = [row for row in rows if row.ticked]
        # An editor's change to the AI's figure is the thing to look at, so it
        # is counted and marked rather than left to be spotted by eye.
        changed = [
            row for row in kept
            if row.suggested_price is not None and row.saved_price is not None
            and abs(row.saved_price - row.suggested_price) >= 0.005
        ]

        return templates.TemplateResponse(
            request,
            "editorial_draft.html",
            {
                "user": user,
                "flash": None,
                "site": site,
                "section": "editorial",
                "crumbs": [
                    {"label": site.name, "href": f"/console/sites/{site.slug}"},
                    {"label": "Editorial update", "href": f"/console/sites/{site.slug}/editorial"},
                    {"label": f"AI draft #{draft.id}"},
                ],
                "tone_for": tone_for,
                "title": f"AI draft #{draft.id} · {site.name}",
                "draft": draft,
                "created_at": str(draft.created_at or "").replace(" ", "T"),
                "number": _price,
                "rows": rows,
                "benchmarks": [
                    row for row in draft.rows
                    if row.is_benchmark and row.suggested_price is not None
                ],
                "saved": saved,
                "counts": {
                    "locations": len(rows),
                    "priced": sum(1 for row in rows if row.suggested_price is not None),
                    "kept": len(kept),
                    "changed": len(changed),
                },
            },
        )

    @router.post("/console/sites/{slug}/editorial")
    async def save_instructions(request: Request, slug: str):
        """The one thing the upload form still posts here for: the editor's
        saved-per-site instructions. Reading and drafting are now separate
        screens (routes_reading.py and the analyse route below); this branch
        is what used to sit ahead of them in the one-step handler, kept
        because those instructions ride on both steps -- reading_prompt and
        editorial_prompt both read `site.editorial_instructions` on their own."""
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        instructions = str(form_data.get("instructions") or "").strip()

        # Remembered per site, so "the USA prices sit in the picture table"
        # is written once, not retyped every week. Blank clears it.
        if instructions != (site.editorial_instructions or ""):
            store.set_editorial_instructions(site.slug, instructions)

        return RedirectResponse(
            f"/console/sites/{site.slug}/editorial?ok={quote('Instructions saved.')}",
            status_code=303,
        )


    engine = Engine(
        store=store, extractions=extractions, driver=driver, default_model=default_model,
        driver_for=driver_for, usage=usage, rules=rules, fx=fx, rounding=rounding, drafts=drafts,
    )

    if extractions is not None:

        @router.post("/console/sites/{slug}/editorial/analyse", response_class=HTMLResponse)
        async def analyse(request: Request, slug: str):
            user, site, response = guard(request, slug)

            if response is not None:
                return response

            form_data = await request.form()
            pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()

            try:
                set_id = int(str(form_data.get("set_id") or "").strip())
            except ValueError:
                return screen(
                    request, user, site, {"error": "That reading could not be found."}, 404
                )

            # The editor asked, on the refusal screen, to use these checked
            # prices a second time -- a staging failure or a closed tab loses
            # the draft, and the reports themselves are not kept, so without
            # this the only way back is re-uploading five files and retyping
            # every correction. `used_at` is the value the reuse button was
            # drawn with; reclaim_set swaps only that exact value, so a
            # refresh or a back-forward re-POST arrives stale and buys nothing.
            try:
                result = draft_prices(
                    engine, site, user.email, client_for(site),
                    set_id=set_id,
                    pricedate=pricedate,
                    again=str(form_data.get("again") or "").strip() == "1",
                    held=str(form_data.get("used_at") or ""),
                )
            except FlowError as refused:
                return screen(
                    request, user, site,
                    {"error": refused.message, "reuse": refused.reuse},
                    refused.status,
                )

            return screen(request, user, site, result)

    @router.get("/console/sites/{slug}/editorial/drafts/{draft_id}/workings.csv")
    def workings_csv(request: Request, slug: str, draft_id: int):
        """The draft as a sheet that argues for itself.

        One line per published price: the figure, the report it came from,
        the range that report printed, every step of the arithmetic, and
        whether those steps reach the figure. This is what goes to the
        client instead of a bare column of numbers -- the rows queried in
        all four October rounds were the ones whose figure appears nowhere
        in the report, and a row that explains itself is not queried.
        """
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        draft = drafts.draft(draft_id, site.slug) if drafts is not None else None

        if draft is None:
            return screen(
                request, user, site,
                {"error": "That draft is no longer here."},
                status=404,
            )

        filename = f"{site.slug}-{draft.price_date or draft.id}-workings.csv"

        return Response(
            content=workings_sheet(draft),
            media_type="text/csv; charset=utf-8",
            headers={"content-disposition": f'attachment; filename="{filename}"'},
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
        # Derived rows also carry calc_N -- the formula that produced them --
        # so the audit trail can say WHERE a saved price came from, which the
        # owner requires for every derived price.
        derivations = []

        while f"loc_{index}" in form_data:
            location = str(form_data.get(f"loc_{index}") or "").strip()
            price = str(form_data.get(f"price_{index}") or "").strip()
            included = form_data.get(f"inc_{index}") is not None
            calculation = str(form_data.get(f"calc_{index}") or "").strip()

            index += 1

            if not included or not location or not price:
                continue

            try:
                rows.append({"location": location, "price": float(price)})
            except ValueError:
                continue

            if calculation:
                derivations.append(f"{location} = {price}: {calculation}")

        # Link the saved update back to the AI's draft. A form without a
        # usable id saves as before.
        try:
            draft_id = int(str(form_data.get("draft_id") or "").strip())
        except ValueError:
            draft_id = None

        try:
            batch_id, saved = save_draft(
                engine, site, user.email, client_for(site),
                rows=rows, derivations=derivations, pricedate=pricedate, draft_id=draft_id,
            )
        except FlowError as refused:
            return RedirectResponse(f"{path}?err={quote(refused.message)}", status_code=303)

        return RedirectResponse(
            f"/console/sites/{site.slug}/prices/{batch_id}"
            f"?ok={quote(f'Saved price update #{batch_id} with {saved} price(s). Nothing is on the website yet.')}",
            status_code=303,
        )

    return router
