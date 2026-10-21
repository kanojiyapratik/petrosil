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
"""

from __future__ import annotations

import math
import re
from datetime import date
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from scraper.pdf import pdf_needs_password

from ..editorial.extract import document_images, document_to_text
from ..editorial.reading import parse_reading, reading_prompt, split_for_reading
from .access import make_site_guard
from .routes import tone_for
from .routes_editorial import MAX_DOCUMENTS, MAX_DOCUMENT_BYTES

# The shape the screen and the prompt both ask for. It is only the shape:
# "2026-13-01" and "2026-02-31" match it and are not days, so the calendar
# itself has the last word below.
_ISO_SHAPE = re.compile(r"\d{4}-\d{2}-\d{2}")

IMAGE_PROMPT = (
    "Transcribe every price table and price figure in these images as "
    "plain text. Keep all company names, grades, viscosities and numbers "
    "exactly as shown, one line per row, with column labels. Start each "
    "table with its title and say which currency every column is in "
    "(e.g. 'Local currency/t' and '$/t' side by side are two different "
    "prices for the same row) -- a figure without its currency is useless."
)


def _is_a_day(text: str) -> bool:
    """YYYY-MM-DD, and a day that exists.

    A shape check alone let a hand-typed "2026-02-31" through to a DATE
    column, where psycopg raised and the whole row edit became a 500 --
    losing every other correction in that row.
    """
    if not _ISO_SHAPE.fullmatch(text):
        return False

    try:
        date.fromisoformat(text)
    except ValueError:
        return False

    return True


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

        chosen = driver_for(site.slug) if driver_for is not None else None
        active = chosen or driver
        model = getattr(chosen, "model", default_model) if chosen is not None else default_model
        provider_name = getattr(chosen or driver, "provider_key", "gemini")

        reading = extractions.open_set(site.slug, user.email)
        failures = []

        def read_pictures(filename: str, pictures: str) -> list[dict]:
            """Rows from a report's page pictures, each saying where it came
            from. A failure costs these rows only, and is said out loud."""
            try:
                prompt = reading_prompt(
                    pictures, f"{filename} (pages read as pictures)", instructions
                )
                seen = (
                    active.generate(prompt) if chosen is not None
                    else active.generate(model, prompt)
                )
            except Exception as error:  # noqa: BLE001
                note_usage(
                    kind="extract_file_pictures", provider=provider_name, model=model,
                    status="failed", site_slug=site.slug,
                )
                failures.append(f"{filename}: the figures in its pictures were not read — {error}")

                return []

            note_usage(
                kind="extract_file_pictures", provider=provider_name, model=model,
                status=seen.status, prompt_tokens=seen.prompt_tokens,
                completion_tokens=seen.completion_tokens, site_slug=site.slug,
            )

            if seen.status != "complete":
                failures.append(
                    f"{filename}: the figures in its pictures were not read — "
                    + (seen.error or f"the model stopped ({seen.status}).")
                )

                return []

            found = parse_reading(seen.text)

            for row in found:
                row["note"] = "; ".join(
                    filter(None, [row.get("note"), "read from a picture of the page"])
                )

            return found

        for filename, raw in bodies:
            text = document_to_text(filename, raw)
            images = document_images(filename, raw)
            # What the pictures say, read on its own below -- see there.
            pictures = ""

            # Reports embed whole price tables as pictures -- the USA posted
            # prices are one -- so each file's own pictures are transcribed
            # into its own text before it is read. A provider without vision
            # costs the pictures, never the file. Every way that can fail is
            # said out loud: a picture silently unread is 40 plausible rows
            # with the USA prices quietly missing from them.
            if images and not hasattr(active, "generate_with_images"):
                failures.append(
                    f"{filename}: {len(images)} image(s) in it could not be read — "
                    "pick a vision-capable provider on the AI settings screen."
                )
            elif images:
                try:
                    # The editor's note is usually about the pictures themselves
                    # ("the USA prices are in the picture"), so it rides here too.
                    image_prompt = IMAGE_PROMPT

                    if instructions:
                        image_prompt += (
                            "\nEditor's instructions (guidance only): " + instructions
                        )

                    seen = active.generate_with_images(image_prompt, images[:6])
                    note_usage(
                        kind="extract_file_images", provider=provider_name, model=model,
                        status=seen.status, prompt_tokens=seen.prompt_tokens,
                        completion_tokens=seen.completion_tokens, site_slug=site.slug,
                    )

                    if seen.status == "complete" and (seen.text or "").strip():
                        pictures = seen.text
                    else:
                        failures.append(
                            f"{filename}: the pictures in it were not read — "
                            + (seen.error or "the model declined to read them.")
                        )
                except Exception as error:  # noqa: BLE001 - pictures are optional
                    note_usage(
                        kind="extract_file_images", provider=provider_name, model=model,
                        status="failed", site_slug=site.slug,
                    )
                    failures.append(f"{filename}: the pictures in it were not read — {error}")

            # A scan has no text of its own: the pictures ARE the report.
            if not text.strip():
                text, pictures = pictures, ""

            if not text.strip():
                extractions.add_rows(reading.id, filename, [])
                failures.append(
                    f"{filename} is locked with a password — save it unlocked and upload it again"
                    if filename.lower().endswith(".pdf") and pdf_needs_password(raw)
                    else f"{filename} could not be read"
                )
                continue

            # A long report is read a few pages at a time. Asked for all 19
            # at once the model answers for the first few and stops -- see
            # split_for_reading. One section failing costs that section.
            sections = split_for_reading(text)
            rows = []

            for number, section in enumerate(sections, start=1):
                part = (
                    filename if len(sections) == 1
                    else f"{filename} (part {number} of {len(sections)})"
                )

                # One file failing costs that file. Four reports already read
                # are never thrown away because the fifth timed out.
                try:
                    prompt = reading_prompt(section, part, instructions)
                    answer = (
                        active.generate(prompt) if chosen is not None
                        else active.generate(model, prompt)
                    )
                except Exception as error:  # noqa: BLE001
                    note_usage(
                        kind="extract_file", provider=provider_name, model=model,
                        status="failed", site_slug=site.slug,
                    )
                    failures.append(f"{part}: {error}")
                    continue

                note_usage(
                    kind="extract_file", provider=provider_name, model=model,
                    status=answer.status, prompt_tokens=answer.prompt_tokens,
                    completion_tokens=answer.completion_tokens, site_slug=site.slug,
                )

                if answer.status == "complete":
                    rows += parse_reading(answer.text)
                else:
                    # A length cap, a refusal or a safety stop is not a part
                    # with no prices in it, and the screen said the same
                    # thing for both.
                    failures.append(
                        f"{part} was not read to the end — "
                        + (answer.error or f"the model stopped ({answer.status}).")
                    )

            # The pictures' text gets its own, short reading. Appended to a
            # 20-page report it sat at the end of ~15,000 tokens and was
            # skimmed: the 11 Sep Argus "Turkey 29,084 ... 600" line was
            # transcribed perfectly, then dropped by the same model on one run
            # in two. Read alone it is a page of tables and nothing else.
            if pictures.strip():
                rows += read_pictures(filename, pictures)

            extractions.add_rows(reading.id, filename, rows)

        store.record(
            user.email, "read reports", site.slug, f"{len(bodies)} file(s), reading #{reading.id}"
        )
        query = {"pricedate": pricedate}

        if failures:
            query["err"] = "; ".join(failures)[:1000]

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
        """One panel per file that was read -- per row of the files table, not
        per filename. Two reports both called report.docx are two uploads and
        two panels; keying on the name merged them into one.

        Rows written before migration 0010 have no file_id. They still have to
        land in the panel their file already made, so the panels are reachable
        by name as well as by id: console_reading_files.id is never NULL, so a
        name-only lookup was the one thing a legacy row could do, and without
        it every such file was drawn twice -- once empty, saying "No prices
        found in this report" above its own twelve prices.
        """
        panels: dict[int, dict] = {}
        by_name: dict[str, dict] = {}
        order: list[dict] = []

        def panel_for(file_id: int | None, filename: str) -> dict:
            if file_id is not None and file_id in panels:
                return panels[file_id]

            if file_id is None and filename in by_name:
                return by_name[filename]

            made = {"id": file_id, "filename": filename, "rows": []}

            if file_id is not None:
                panels[file_id] = made

            # First file of a given name wins the name, so a legacy row goes
            # to the earliest panel that could have produced it.
            by_name.setdefault(filename, made)
            order.append(made)

            return made

        for entry in reading.files:
            panel_for(getattr(entry, "id", None), getattr(entry, "filename", entry))

        for row in rows:
            panel_for(getattr(row, "file_id", None), row.filename)["rows"].append(row)

        return order

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

    def checked_fields(form_data) -> tuple[dict | None, str | None]:
        """One row's worth of hand-typed figures, or the reason to refuse them.

        Shared by the correction form and the add-a-row form, so a row the
        editor types is held to exactly what a row the editor corrects is.
        """

        def numeric(field: str) -> float | None:
            raw = form_data.get(field)
            raw = raw.strip() if isinstance(raw, str) else raw

            if not raw:
                return None

            number = float(raw)

            # float("nan") <= 0 is False, so nan walked straight past a
            # positivity check and into a NUMERIC column. Same rule as
            # review.py's _positive_number.
            if not math.isfinite(number):
                raise ValueError("not a finite number")

            return number

        def optional(field: str) -> str | None:
            value = form_data.get(field)
            value = value.strip() if isinstance(value, str) else value

            return value or None

        try:
            price = numeric("price")
            price_min = numeric("price_min")
            price_max = numeric("price_max")
        except (TypeError, ValueError):
            return None, "That price is not a number."

        if price is None:
            return None, "That row needs a price."

        if price <= 0:
            return None, "A price has to be more than zero."

        name = str(form_data.get("name") or "").strip()

        # TEXT NOT NULL takes the empty string happily. A nameless row stays
        # ticked, reaches the analysis as {"name": ""}, cannot be placed
        # against any location, and the price simply disappears.
        if not name:
            return None, "That row needs a name — a price with no name cannot be used."

        date_text = optional("price_date")

        if date_text and not _is_a_day(date_text):
            return None, "That date is not a real day in YYYY-MM-DD form."

        return (
            {
                "name": name,
                "price": price,
                "price_min": price_min,
                "price_max": price_max,
                "currency": optional("currency"),
                "unit": optional("unit"),
                "basis": optional("basis"),
                "price_date": date_text,
                "note": optional("note"),
                "kept": "kept" in form_data,
            },
            None,
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
        fields, complaint = checked_fields(form_data)

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

        fields, complaint = checked_fields(form_data)

        if complaint is not None:
            return refuse(complaint)

        extractions.add_row(set_id, filename, fields, file_id=file_id)
        store.record(user.email, "added a price", site.slug, f"{fields['name']} in {filename}")

        return RedirectResponse(
            f"/console/sites/{slug}/reading/{set_id}?{urlencode({'pricedate': pricedate})}",
            status_code=303,
        )

    return router
