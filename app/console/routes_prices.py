"""The price-update screens: stage a batch, review every row, commit.

Split from routes.py because these are the biggest screens in the console and
the two sets share nothing but the layout.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..db.store import Store, StoredSite
from .routes import NEEDS_ATTENTION, VALUE_EDITABLE, tone_for
from .site_client import SiteClient, SiteError


def create_price_routes(
    *,
    store: Store,
    templates: Jinja2Templates,
    current_user,
    client_factory=None,
) -> APIRouter:
    router = APIRouter()

    def client_for(site: StoredSite) -> SiteClient:
        if client_factory is not None:
            return client_factory(site)

        return SiteClient(base_url=site.api_url, token=site.token, name=site.name)

    def locations_of(site: StoredSite) -> list[dict]:
        """A site that cannot answer must not take the whole screen down with
        it: without the list the bulk-edit form and the location fixer are
        unusable, but the batch list and every other row still are."""
        try:
            return client_for(site).locations().get("data", [])
        except SiteError:
            return []

    def flash_of(request: Request):
        if request.query_params.get("ok"):
            return {"kind": "ok", "text": request.query_params["ok"]}

        if request.query_params.get("err"):
            return {"kind": "bad", "text": request.query_params["err"]}

        return None

    def back(path: str, kind: str, text: str) -> RedirectResponse:
        return RedirectResponse(f"{path}?{kind}={quote(text)}", status_code=303)

    def guard(request: Request, slug: str):
        """Returns (user, site) or a response to send instead."""
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
                        "user": user,
                        "flash": None,
                        "site": None,
                        "section": None,
                        "crumbs": None,
                        "tone_for": tone_for,
                        "title": "No such site",
                        "message": "That site is not configured, or has been turned off.",
                    },
                    status_code=404,
                ),
            )

        return user, site, None

    @router.get("/console/sites/{slug}/prices", response_class=HTMLResponse)
    def prices(request: Request, slug: str):
        """Forwards to the editorial screen — the one price screen since the
        owner's ruling. This URL lives on in histories and bookmarks, and its
        Excel-only upload form kept catching editors who wanted to upload a
        report. The batch pages beneath it (/prices/{id}) stay."""
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        return RedirectResponse(f"/console/sites/{site.slug}/editorial", status_code=303)

    @router.get("/console/sites/{slug}/prices-manual", response_class=HTMLResponse)
    def prices_manual(request: Request, slug: str):
        """The old screen (exact file upload + bulk edit), kept reachable at a
        deliberate address for the rare case the editorial flow is wrong for
        the job -- an exact sheet of decided prices must not pass through a
        model."""
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        try:
            batches = client_for(site).batches().get("data", [])
        except SiteError as error:
            return templates.TemplateResponse(
                request,
                "error.html",
                {
                    "user": user,
                    "flash": None,
                    "site": site,
                    "section": "prices",
                    "crumbs": None,
                    "tone_for": tone_for,
                    "title": "Could not reach the site",
                    "message": str(error),
                },
                status_code=502,
            )

        return templates.TemplateResponse(
            request,
            "prices.html",
            {
                "user": user,
                "flash": flash_of(request),
                "site": site,
                "section": "prices",
                "crumbs": [
                    {"label": site.name, "href": f"/console/sites/{site.slug}"},
                    {"label": "Update prices"},
                ],
                "tone_for": tone_for,
                "title": f"Prices · {site.name}",
                "batches": [{**batch, "tone": tone_for(batch.get("status"))} for batch in batches],
                "locations": locations_of(site),
            },
        )

    @router.post("/console/sites/{slug}/prices/upload")
    async def upload(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        upload_file = form.get("file")
        path = f"/console/sites/{site.slug}/prices"

        if upload_file is None or not getattr(upload_file, "filename", ""):
            return back(path, "err", "Choose a file to upload.")

        content = await upload_file.read()

        if not content:
            return back(path, "err", "That file is empty.")

        try:
            # Relayed to the site untouched: reading the sheet is its job,
            # because it knows its own locations and date formats.
            result = client_for(site).upload_batch(
                upload_file.filename, content, str(form.get("pricedate") or "")
            )
        except SiteError as error:
            return back(path, "err", str(error))

        batch_id = result.get("batch", {}).get("id")
        store.record(
            user.email, "uploaded a price file", site.slug, f"{upload_file.filename} to batch #{batch_id}"
        )

        return back(
            f"{path}/{batch_id}",
            "ok",
            f"Staged batch #{batch_id} from {upload_file.filename}. Nothing is committed yet.",
        )

    @router.post("/console/sites/{slug}/prices/bulk")
    async def bulk(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        path = f"/console/sites/{site.slug}/prices"
        location_ids = [int(value) for value in form.getlist("location_ids") if str(value).isdigit()]

        if not location_ids:
            return back(path, "err", "Pick at least one location.")

        # Only fields that were actually filled in are forwarded. Each
        # operation has its own required fields on the site, and sending empty
        # strings for the ones this operation does not use would fail that
        # validation for no reason.
        params: dict = {"location_ids": location_ids}

        for key in (
            "operation",
            "date_from",
            "date_to",
            "value",
            "source_date",
            "target_date_from",
            "target_date_to",
        ):
            value = form.get(key)

            if isinstance(value, str) and value.strip() != "":
                params[key] = value

        try:
            result = client_for(site).bulk_batch(params)
        except SiteError as error:
            return back(path, "err", str(error))

        batch_id = result.get("batch", {}).get("id")
        store.record(
            user.email,
            "staged a bulk edit",
            site.slug,
            f"{params.get('operation', '?')} on {len(location_ids)} location(s) to batch #{batch_id}",
        )

        return back(f"{path}/{batch_id}", "ok", f"Staged batch #{batch_id}. Nothing is committed yet.")

    @router.get("/console/sites/{slug}/prices/{batch_id}", response_class=HTMLResponse)
    def batch(request: Request, slug: str, batch_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        try:
            envelope = client_for(site).batch(batch_id)
        except SiteError as error:
            return templates.TemplateResponse(
                request,
                "error.html",
                {
                    "user": user,
                    "flash": None,
                    "site": site,
                    "section": "prices",
                    "crumbs": None,
                    "tone_for": tone_for,
                    "title": "Could not load the batch",
                    "message": str(error),
                },
                status_code=502,
            )

        base = f"/console/sites/{site.slug}/prices"
        items = envelope.get("items", [])
        summary = envelope.get("summary") or {}

        # A 500-row batch with three unmatched rows in it is otherwise a
        # hunt. "blocking" is its own filter because that is the question an
        # admin actually has: what is stopping me committing this.
        chosen = request.query_params.get("status") or ""

        if chosen == "blocking":
            shown = [
                item
                for item in items
                if item.get("status") in NEEDS_ATTENTION and item.get("is_included")
            ]
        elif chosen:
            shown = [item for item in items if item.get("status") == chosen]
        else:
            shown = items

        blocking = len(
            [
                item
                for item in items
                if item.get("status") in NEEDS_ATTENTION and item.get("is_included")
            ]
        )

        filters = [{"key": "", "label": "All", "count": len(items)}]

        if blocking:
            filters.append({"key": "blocking", "label": "Blocking", "count": blocking})

        filters += [
            {"key": status, "label": status, "count": count}
            for status, count in summary.items()
            if count
        ]

        return templates.TemplateResponse(
            request,
            "batch.html",
            {
                "user": user,
                "flash": flash_of(request),
                "site": site,
                "section": "prices",
                "crumbs": [
                    {"label": site.name, "href": f"/console/sites/{site.slug}"},
                    {"label": "Update prices", "href": base},
                    {"label": f"Batch #{batch_id}"},
                ],
                "tone_for": tone_for,
                "title": f"Batch #{batch_id} · {site.name}",
                "envelope": envelope,
                "items": shown,
                "filters": filters,
                "chosen": chosen,
                "total_items": len(items),
                "summary_counts": [
                    (status, count) for status, count in summary.items() if count
                ],
                "draft": envelope.get("batch", {}).get("status") == "draft",
                "base": base,
                "locations": locations_of(site),
                "needs_attention": NEEDS_ATTENTION,
                "value_editable": VALUE_EDITABLE,
            },
        )

    @router.post("/console/sites/{slug}/prices/{batch_id}/items/{item_id}")
    async def update_item(request: Request, slug: str, batch_id: int, item_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form = await request.form()
        path = f"/console/sites/{site.slug}/prices/{batch_id}"
        patch: dict = {}

        # Only what this form actually sent. The site re-diffs a row whenever
        # a value changes, so forwarding a field that did not change would
        # recompute its status for nothing.
        if str(form.get("new_price") or "") != "":
            patch["new_price"] = float(str(form.get("new_price")))

        if str(form.get("location_id") or "") != "":
            patch["location_id"] = int(str(form.get("location_id")))

        if form.get("is_included") is not None:
            patch["is_included"] = str(form.get("is_included")) == "1"

        if not patch:
            return back(path, "err", "Nothing to change.")

        try:
            client_for(site).update_item(item_id, patch)
        except SiteError as error:
            return back(path, "err", str(error))

        return RedirectResponse(path, status_code=303)

    @router.post("/console/sites/{slug}/prices/{batch_id}/commit")
    def commit(request: Request, slug: str, batch_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        path = f"/console/sites/{site.slug}/prices/{batch_id}"

        try:
            result = client_for(site).commit_batch(batch_id)
        except SiteError as error:
            return back(path, "err", str(error))

        # The one action in this console that changes a live price, which is
        # what the audit trail exists for.
        committed = result.get("committed")
        store.record(
            user.email,
            "COMMITTED a batch to live prices",
            site.slug,
            f"batch #{batch_id}" + (f" ({committed} rows)" if committed else ""),
        )

        return back(path, "ok", f"Batch #{batch_id} committed to live prices.")

    @router.post("/console/sites/{slug}/prices/{batch_id}/rollback")
    def rollback(request: Request, slug: str, batch_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        path = f"/console/sites/{site.slug}/prices/{batch_id}"

        try:
            client_for(site).rollback_batch(batch_id)
        except SiteError as error:
            return back(path, "err", str(error))

        store.record(user.email, "ROLLED BACK a committed batch", site.slug, f"batch #{batch_id}")

        return back(path, "ok", f"Batch #{batch_id} rolled back.")

    @router.post("/console/sites/{slug}/prices/{batch_id}/discard")
    def discard(request: Request, slug: str, batch_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        try:
            client_for(site).discard_batch(batch_id)
        except SiteError as error:
            return back(f"/console/sites/{site.slug}/prices/{batch_id}", "err", str(error))

        store.record(user.email, "discarded a draft batch", site.slug, f"batch #{batch_id}")

        return back(f"/console/sites/{site.slug}/prices", "ok", f"Batch #{batch_id} discarded.")

    return router
