"""Step one: each uploaded report read on its own, and checked.

One AI call per file. A single prompt holding five reports runs to 65k
characters and gets skimmed -- measured on the 19.08 Lube Report, where
gpt-4o-mini returned nothing at all across 47 locations. One report per call
is small enough to be read properly, and it makes plain which file gave
what, which a merged prompt never could.

A file that fails costs that file. Four reports already read are never
thrown away because the fifth timed out -- and a file that failed says so on
the screen, because a silent failure and a report with no prices in it look
identical otherwise.

The work itself is in flows.py, shared with the app's AI tools tab; this
module is the console's screens around it.
"""

from __future__ import annotations

from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from scraper.pdf import pdf_needs_password

from ..editorial.extract import document_images, document_to_text
from .access import make_site_guard
from .flows import MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, Engine, check_row_fields, grouped_files, read_reports
from .routes import tone_for


def create_reading_routes(
    *, store, extractions, templates: Jinja2Templates, current_user,
    driver, default_model: str, driver_for=None, usage=None,
) -> APIRouter:
    router = APIRouter()
    engine = Engine(
        store=store, extractions=extractions, driver=driver,
        default_model=default_model, driver_for=driver_for, usage=usage,
    )

    # Returns (user, site, a-response-to-send-instead). The one implementation
    # lives in access.py, so a site the signed-in user has not been given
    # answers the same 404 here as it does on every other screen.
    guard = make_site_guard(store=store, templates=templates, current_user=current_user)

    def screen(request: Request, user, site, extra: dict, status: int = 200):
        context = {
            "user": user,
            "flash": None,
            "site": site,
            "section": "editorial",
            "crumbs": [
                {"label": site.name, "href": f"/console/sites/{site.slug}"},
                {"label": "Check what was read"},
            ],
            "tone_for": tone_for,
            "title": f"Check what was read · {site.name}",
            "error": None,
            "set": None,
            "files": [],
            # The date the checked prices are analysed as of -- carried from
            # the upload form through to the "Use these prices" form, so it
            # is never silently swapped for today's.
            "pricedate": date.today().isoformat(),
        }
        context.update(extra)

        return templates.TemplateResponse(request, "reading.html", context, status_code=status)

    def back_to_upload(slug: str, message: str) -> RedirectResponse:
        """A rejected upload belongs on the screen that carries the upload
        form. Rendering reading.html with no reading gave a page headed
        "Check what was read" saying "Nothing has been read yet", with
        nothing on it to try again with."""
        return RedirectResponse(
            f"/console/sites/{slug}/editorial?err={quote(message)}", status_code=303
        )

    @router.post("/console/sites/{slug}/reading")
    async def read_files(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        uploads = [f for f in form_data.getlist("documents") if getattr(f, "filename", "")]
        # The saved rulebook used to ride along on every upload without
        # anyone looking at it. Four rounds of mismatch files in October 2026
        # turned on what the model was or was not told, and afterwards nobody
        # could say which instructions had been in force for a given run.
        #
        # So it is now an explicit tick on the upload form, with the text
        # shown beside it. An unticked box posts nothing at all, which is
        # what "leave them out of this run" looks like over HTTP; a box the
        # editor has typed into sends that version for this run WITHOUT
        # changing what is saved, so trying something once cannot quietly
        # rewrite the rulebook.
        if form_data.get("use_instructions") is None:
            instructions = None
        else:
            typed = str(form_data.get("instructions") or "").strip()
            instructions = typed or (site.editorial_instructions or "").strip() or None
        # The date the editor picked on this form -- carried to the analyse
        # step over the redirect below, never silently replaced by today's.
        pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()

        if not uploads:
            return back_to_upload(slug, "Choose at least one report.")

        if len(uploads) > MAX_DOCUMENTS:
            return back_to_upload(slug, f"At most {MAX_DOCUMENTS} reports at a time.")

        bodies = []

        for upload in uploads:
            raw = await upload.read()

            if len(raw) > MAX_DOCUMENT_BYTES:
                return back_to_upload(slug, f"{upload.filename} is larger than 10 MB.")

            bodies.append((upload.filename or "report", raw))

        # The readers are this module's names, looked up now, so a test that
        # stands in for one here still stands in for it.
        result = read_reports(
            engine, site, user.email, bodies, instructions,
            document_to_text=document_to_text,
            document_images=document_images,
            pdf_needs_password=pdf_needs_password,
        )
        query = {"pricedate": pricedate}

        if result.failures:
            query["err"] = "; ".join(result.failures)[:1000]

        target = f"/console/sites/{slug}/reading/{result.reading.id}?{urlencode(query)}"

        return RedirectResponse(target, status_code=303)

    def not_found(request: Request, user, site):
        return templates.TemplateResponse(
            request,
            "error.html",
            {
                "user": user, "flash": None, "site": site, "section": "editorial",
                "crumbs": [
                    {"label": site.name, "href": f"/console/sites/{site.slug}"},
                    {"label": "Check what was read"},
                ],
                "tone_for": tone_for, "title": "No such reading",
                "message": "That set of reports could not be found.",
            },
            status_code=404,
        )

    @router.get("/console/sites/{slug}/reading/{set_id}", response_class=HTMLResponse)
    def check(request: Request, slug: str, set_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        reading = extractions.set_by_id(set_id)

        if reading is None or reading.site_slug != site.slug:
            return not_found(request, user, site)

        rows = extractions.rows_for(set_id)
        files = grouped_files(reading, rows)

        flash = None

        if request.query_params.get("err"):
            flash = {"kind": "bad", "text": request.query_params["err"]}

        pricedate = request.query_params.get("pricedate") or date.today().isoformat()

        return screen(
            request, user, site,
            {"set": reading, "files": files, "flash": flash, "pricedate": pricedate},
        )

    @router.post("/console/sites/{slug}/reading/{set_id}/rows/{row_id}")
    async def edit_row(request: Request, slug: str, set_id: int, row_id: int):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        # The set must belong to this site, and the row must belong to this
        # set -- otherwise `POST .../reading/1/rows/<any id>` could read or
        # rewrite a row that has nothing to do with the reading on screen,
        # which is exactly what `check` above is careful never to show.
        reading = extractions.set_by_id(set_id)

        if reading is None or reading.site_slug != site.slug:
            return not_found(request, user, site)

        rows = extractions.rows_for(set_id)
        row = next((candidate for candidate in rows if candidate.id == row_id), None)

        if row is None or row.set_id != set_id:
            return not_found(request, user, site)

        form_data = await request.form()
        # Carried in a hidden field on each row's own form (reading.html), so
        # a row correction never resets the date chosen on the foot form back
        # to today.
        pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()
        fields, complaint = check_row_fields(form_data)

        if complaint is not None:
            return screen(
                request, user, site,
                {
                    "set": reading, "files": grouped_files(reading, rows), "error": complaint,
                    "pricedate": pricedate,
                },
                422,
            )

        extractions.update_row(row_id, **fields)

        return RedirectResponse(
            f"/console/sites/{slug}/reading/{set_id}?{urlencode({'pricedate': pricedate})}",
            status_code=303,
        )

    @router.post("/console/sites/{slug}/reading/{set_id}/rows")
    async def add_row(request: Request, slug: str, set_id: int):
        """The spec's fourth verb: "change a figure, fix a name, drop a row, or
        add one the model missed". When the model skips a whole table the
        editor can now see the gap -- this is what lets them fill it."""
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        reading = extractions.set_by_id(set_id)

        if reading is None or reading.site_slug != site.slug:
            return not_found(request, user, site)

        rows = extractions.rows_for(set_id)
        form_data = await request.form()
        pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()
        panels = grouped_files(reading, rows)

        raw_file_id = str(form_data.get("file_id") or "").strip()
        file_id = int(raw_file_id) if raw_file_id.isdigit() else None
        panel = next(
            (entry for entry in panels if file_id is not None and entry.get("id") == file_id),
            None,
        )
        filename = (
            panel["filename"] if panel is not None
            else str(form_data.get("filename") or "").strip()
        )

        def refuse(message: str) -> HTMLResponse:
            return screen(
                request, user, site,
                {"set": reading, "files": panels, "error": message, "pricedate": pricedate},
                422,
            )

        # The new row has to land under a file of this reading, or it would
        # show up in no panel at all and be invisible the moment it was typed.
        if panel is None and filename not in {entry["filename"] for entry in panels}:
            return refuse("That price could not be added to any of these reports.")

        fields, complaint = check_row_fields(form_data)

        if complaint is not None:
            return refuse(complaint)

        extractions.add_row(set_id, filename, fields, file_id=file_id)
        store.record(user.email, "added a price", site.slug, f"{fields['name']} in {filename}")

        return RedirectResponse(
            f"/console/sites/{slug}/reading/{set_id}?{urlencode({'pricedate': pricedate})}",
            status_code=303,
        )

    return router
