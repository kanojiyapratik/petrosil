"""Step one: each uploaded report read on its own, and checked.

One AI call per file. A single prompt holding five reports runs to 65k
characters and gets skimmed -- measured on the 19.08 Lube Report, where
gpt-4o-mini returned nothing at all across 47 locations. One report per call
is small enough to be read properly, and it makes plain which file gave
what, which a merged prompt never could.

A file that fails costs that file. Four reports already read are never
thrown away because the fifth timed out.
"""

from __future__ import annotations

import re
from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..editorial.extract import document_images, document_to_text
from ..editorial.reading import parse_reading, reading_prompt
from .routes import tone_for
from .routes_editorial import MAX_DOCUMENTS, MAX_DOCUMENT_BYTES

# Same shape parse_reading holds a model's own reports to (app/editorial/reading.py).
# A hand-typed correction is held to it too -- a garbled date is a screenful, not a
# 500 from the database's DATE column.
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def create_reading_routes(
    *, store, extractions, templates: Jinja2Templates, current_user,
    driver, default_model: str, driver_for=None, usage=None,
) -> APIRouter:
    router = APIRouter()

    def note_usage(**fields) -> None:
        # The ledger is a record of the work, never a condition of it.
        if usage is None:
            return

        try:
            usage.record(**fields)
        except Exception:  # noqa: BLE001
            pass

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

    @router.post("/console/sites/{slug}/reading")
    async def read_files(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        uploads = [f for f in form_data.getlist("documents") if getattr(f, "filename", "")]
        instructions = (site.editorial_instructions or "").strip() or None
        # The date the editor picked on this form -- carried to the analyse
        # step over the redirect below, never silently replaced by today's.
        pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()

        if not uploads:
            return screen(request, user, site, {"error": "Choose at least one report."}, 422)

        if len(uploads) > MAX_DOCUMENTS:
            return screen(
                request, user, site,
                {"error": f"At most {MAX_DOCUMENTS} reports at a time."}, 422,
            )

        bodies = []

        for upload in uploads:
            raw = await upload.read()

            if len(raw) > MAX_DOCUMENT_BYTES:
                return screen(
                    request, user, site,
                    {"error": f"{upload.filename} is larger than 10 MB."}, 422,
                )

            bodies.append((upload.filename or "report", raw))

        chosen = driver_for() if driver_for is not None else None
        active = chosen or driver
        model = getattr(chosen, "model", default_model) if chosen is not None else default_model
        provider_name = getattr(chosen or driver, "provider_key", "gemini")

        reading = extractions.open_set(site.slug, user.email)
        failures = []

        for filename, raw in bodies:
            text = document_to_text(filename, raw)
            images = document_images(filename, raw)

            # Reports embed whole price tables as pictures -- the USA posted
            # prices are one -- so each file's own pictures are transcribed
            # into its own text before it is read. A provider without vision
            # costs the pictures, never the file.
            if images and hasattr(active, "generate_with_images"):
                try:
                    seen = active.generate_with_images(
                        "Transcribe every price table and price figure in these images as "
                        "plain text. Keep all company names, grades, viscosities and numbers "
                        "exactly as shown, one line per row, with column labels.",
                        images[:6],
                    )
                    note_usage(
                        kind="extract_file_images", provider=provider_name, model=model,
                        status=seen.status, prompt_tokens=seen.prompt_tokens,
                        completion_tokens=seen.completion_tokens, site_slug=site.slug,
                    )

                    if seen.status == "complete" and (seen.text or "").strip():
                        text += "\n\nFigures transcribed from pictures in this report:\n" + seen.text
                except Exception:  # noqa: BLE001 - pictures are optional
                    note_usage(
                        kind="extract_file_images", provider=provider_name, model=model,
                        status="failed", site_slug=site.slug,
                    )

            if not text.strip():
                extractions.add_rows(reading.id, filename, [])
                failures.append(f"{filename} could not be read")
                continue

            # One file failing costs that file. Four reports already read are
            # never thrown away because the fifth timed out.
            try:
                prompt = reading_prompt(text, filename, instructions)
                answer = (
                    active.generate(prompt) if chosen is not None
                    else active.generate(model, prompt)
                )
            except Exception as error:  # noqa: BLE001
                note_usage(
                    kind="extract_file", provider=provider_name, model=model,
                    status="failed", site_slug=site.slug,
                )
                extractions.add_rows(reading.id, filename, [])
                failures.append(f"{filename}: {error}")
                continue

            note_usage(
                kind="extract_file", provider=provider_name, model=model,
                status=answer.status, prompt_tokens=answer.prompt_tokens,
                completion_tokens=answer.completion_tokens, site_slug=site.slug,
            )
            extractions.add_rows(
                reading.id, filename,
                parse_reading(answer.text) if answer.status == "complete" else [],
            )

        store.record(
            user.email, "read reports", site.slug, f"{len(bodies)} file(s), reading #{reading.id}"
        )
        query = {"pricedate": pricedate}

        if failures:
            query["err"] = "; ".join(failures)[:400]

        target = f"/console/sites/{slug}/reading/{reading.id}?{urlencode(query)}"

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

    def grouped_files(reading, rows) -> list[dict]:
        rows_by_file: dict[str, list] = {filename: [] for filename in reading.files}

        for row in rows:
            rows_by_file.setdefault(row.filename, []).append(row)

        return [
            {"filename": filename, "rows": file_rows}
            for filename, file_rows in rows_by_file.items()
        ]

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

        def invalid(message: str) -> HTMLResponse:
            return screen(
                request, user, site,
                {
                    "set": reading, "files": grouped_files(reading, rows), "error": message,
                    "pricedate": pricedate,
                },
                422,
            )

        def numeric(field: str) -> float | None:
            raw = form_data.get(field)
            raw = raw.strip() if isinstance(raw, str) else raw

            if not raw:
                return None

            return float(raw)

        try:
            price = numeric("price")

            if price is None or price <= 0:
                raise ValueError("price must be a positive number")

            price_min = numeric("price_min")
            price_max = numeric("price_max")
        except (TypeError, ValueError):
            return invalid("That price is not a number.")

        date_text = form_data.get("price_date")
        date_text = date_text.strip() if isinstance(date_text, str) else date_text
        date_text = date_text or None

        if date_text and not _ISO_DATE.fullmatch(date_text):
            return invalid("That date is not in YYYY-MM-DD form.")

        def optional(field: str) -> str | None:
            value = form_data.get(field)
            value = value.strip() if isinstance(value, str) else value

            return value or None

        fields = {
            "name": (form_data.get("name") or "").strip(),
            "price": price,
            "price_min": price_min,
            "price_max": price_max,
            "currency": optional("currency"),
            "unit": optional("unit"),
            "basis": optional("basis"),
            "price_date": date_text,
            "note": optional("note"),
            "kept": "kept" in form_data,
        }

        extractions.update_row(row_id, **fields)

        return RedirectResponse(
            f"/console/sites/{slug}/reading/{set_id}?{urlencode({'pricedate': pricedate})}",
            status_code=303,
        )

    return router
