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
from ..editorial.extract import document_images, document_to_text
from ..editorial.benchmarks import benchmark_prompt, merge_benchmarks, price_digest
from ..editorial.fx import FrankfurterRates, convert_rows
from ..editorial.review import ParsedSuggestions, build_rows, editorial_prompt, parse_suggestions
from ..editorial.rules import apply_rules, benchmark_names
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
    usage=None,
    rules=None,
    fx=None,
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
            "batches": None,
            "benchmarks": None,
            "image_note": None,
            # The saved per-site instructions prefill the form; after a draft
            # the just-typed text wins, so an edit is never silently reverted.
            "instructions": site.editorial_instructions,
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

        return screen(
            request, user, site,
            {
                "error": request.query_params.get("err"),
                "flash": flash,
                "batches": [
                    {**batch, "tone": tone_for(batch.get("status"))} for batch in batches
                ],
            },
        )

    @router.post("/console/sites/{slug}/editorial", response_class=HTMLResponse)
    async def draft(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()
        instructions = str(form_data.get("instructions") or "").strip()

        # Remembered per site, so "the USA prices sit in the picture table"
        # is written once, not retyped every week. Blank clears it.
        if instructions != (site.editorial_instructions or ""):
            store.set_editorial_instructions(site.slug, instructions)
            # Re-read, so every screen this request renders shows the text
            # that was just typed rather than the stale copy.
            site = store.site_by_slug(site.slug) or site

        uploads = [f for f in form_data.getlist("documents") if getattr(f, "filename", "")]

        if not uploads:
            return screen(request, user, site, {"error": "Choose at least one report file."}, 422)

        if len(uploads) > MAX_DOCUMENTS:
            return screen(
                request, user, site,
                {"error": f"At most {MAX_DOCUMENTS} documents per draft."}, 422,
            )

        texts = []
        images = []

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

            # Reports embed whole price tables as pictures (the USA posted
            # prices are one). They are transcribed by a vision call below.
            images.extend(document_images(upload.filename or "", raw))

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

        provider_name = getattr(chosen or driver, "provider_key", "gemini")

        # Report benchmarks: figures the rulebook derives from that are not
        # site locations ("Report: FOB Asia SN 150"). Asked of the model like
        # any location, shown separately, never staged.
        site_rules = rules.for_site(site.slug) if rules is not None else []
        benchmarks = benchmark_names(site_rules, names)
        asked = names + benchmarks

        # Pictures first: a vision call transcribes any embedded price tables
        # into text, which then rides through the normal extraction with the
        # rest of the reports. A provider without vision costs the pictures,
        # not the draft.
        image_note = None

        if images:
            if chosen is not None and hasattr(chosen, "generate_with_images"):
                try:
                    image_prompt = (
                        "Transcribe every price table and price figure in these images as "
                        "plain text. Keep all company names, grades, viscosities and numbers "
                        "exactly as shown, one line per row, with column labels."
                    )

                    # The editor's note often concerns the pictures themselves
                    # ("the USA prices are in the image"), so it rides along.
                    if instructions:
                        image_prompt += (
                            "\nEditor's instructions (guidance only): " + instructions
                        )

                    seen = chosen.generate_with_images(image_prompt, images[:6])

                    if usage is not None:
                        usage.record(
                            kind="editorial_images", provider=provider_name, model=model,
                            status=seen.status, prompt_tokens=seen.prompt_tokens,
                            completion_tokens=seen.completion_tokens, site_slug=site.slug,
                        )

                    if seen.status == "complete" and (seen.text or "").strip():
                        texts.append(
                            "Figures transcribed from images embedded in the reports:\n"
                            + seen.text
                        )
                    else:
                        image_note = seen.error or "The model declined to read the report images."
                except Exception as error:  # noqa: BLE001 - pictures are optional
                    image_note = str(error)

                    if usage is not None:
                        usage.record(
                            kind="editorial_images", provider=provider_name, model=model,
                            status="failed", site_slug=site.slug,
                        )
            else:
                image_note = (
                    f"{len(images)} image(s) found in the reports could not be read — "
                    "pick a vision-capable provider on the AI settings screen."
                )

        try:
            prompt = editorial_prompt(asked, texts, instructions or None)
            completion = (
                active.generate(prompt) if chosen is not None else active.generate(model, prompt)
            )
        except Exception as error:  # noqa: BLE001 - a provider failure is a screenful, not a 500
            if usage is not None:
                usage.record(
                    kind="editorial", provider=provider_name, model=model,
                    status="failed", site_slug=site.slug,
                )

            return screen(request, user, site, {"error": str(error)}, 502)

        if usage is not None:
            usage.record(
                kind="editorial",
                provider=provider_name,
                model=model,
                status=completion.status,
                prompt_tokens=completion.prompt_tokens,
                completion_tokens=completion.completion_tokens,
                site_slug=site.slug,
            )

        parsed = (
            parse_suggestions(completion.text, asked)
            if completion.status == "complete"
            else ParsedSuggestions()
        )

        # The benchmarks get a second, focused reading: only the reports'
        # price lines, only the benchmark names, one answer per name. The
        # whole-report pass skims them (measured: gpt-4o 8/8, 7/8, 5/8 on
        # identical runs), and every missed benchmark is a Singapore or
        # Russia price the site never gets. See app/editorial/benchmarks.py.
        # A failure here costs the second reading, never the draft.
        benchmark_note = None
        digest = price_digest(texts) if benchmarks else ""

        if digest:
            try:
                focused_prompt = benchmark_prompt(benchmarks, digest, instructions or None)
                focused = (
                    active.generate(focused_prompt)
                    if chosen is not None
                    else active.generate(model, focused_prompt)
                )

                if usage is not None:
                    usage.record(
                        kind="editorial_benchmarks", provider=provider_name, model=model,
                        status=focused.status, prompt_tokens=focused.prompt_tokens,
                        completion_tokens=focused.completion_tokens, site_slug=site.slug,
                    )

                if focused.status == "complete":
                    parsed = merge_benchmarks(
                        parsed, parse_suggestions(focused.text, benchmarks), benchmarks
                    )
                else:
                    benchmark_note = focused.error
            except Exception as error:  # noqa: BLE001 - the second reading is a bonus
                benchmark_note = str(error)

                if usage is not None:
                    usage.record(
                        kind="editorial_benchmarks", provider=provider_name, model=model,
                        status="failed", site_slug=site.slug,
                    )

        rows = build_rows(asked, current, parsed)

        # A figure printed in lira becomes USD at the rate for its own date
        # before any rule sees it; no rate, no conversion, and the rule
        # below it stays silent. See app/editorial/fx.py.
        rows = convert_rows(rows, fx if fx is not None else FrankfurterRates(), pricedate)

        # The rulebook fills what the reports never mention -- code, not the
        # model, does this arithmetic. See app/editorial/rules.py.
        rows = apply_rules(rows, site_rules)

        # Benchmarks fed the rules; they are not site prices and never stage.
        benchmark_set = set(benchmarks)
        benchmark_rows = [row for row in rows if row["location"] in benchmark_set]
        rows = [row for row in rows if row["location"] not in benchmark_set]

        near_matches = sum(1 for row in rows if row["status"] == "near_match")
        summary = {
            "total_locations": len(names),
            "suggested": sum(1 for row in rows if row["status"] == "suggested"),
            "near_match": near_matches,
            "derived": sum(1 for row in rows if row["status"] == "derived"),
            "needs_rate": sum(1 for row in benchmark_rows + rows if row["status"] == "needs_rate"),
            "no_evidence": sum(1 for row in rows if row["status"] == "no_evidence"),
            "invalid": sum(1 for row in rows if row["status"] == "invalid"),
            "flagged": sum(1 for row in rows if row["flag"] is not None),
            "dropped_unknown": len(parsed.unmatched) - near_matches,
        }

        store.record(
            user.email,
            "drafted an editorial update",
            site.slug,
            f"{summary['suggested']} suggestion(s) and {summary['derived']} derived "
            f"by rule from {len(uploads)} report(s)",
        )

        return screen(
            request, user, site,
            {
                "rows": rows,
                "benchmarks": [row for row in benchmark_rows if row["status"] == "suggested"],
                "summary": summary,
                "pricedate": pricedate,
                "image_note": image_note,
                "benchmark_note": benchmark_note,
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
            f"{len(rows)} row(s) to batch #{batch_id}"
            + (f", {len(derivations)} of them derived by rule" if derivations else ""),
        )

        # One audit line per derived price: source, rule and result, kept even
        # after screens move on. "Both the source price and calculation rule
        # are recorded in the audit log" -- the owner's requirement, verbatim.
        for derivation in derivations:
            store.record(
                user.email, "saved a derived price", site.slug,
                f"batch #{batch_id}: {derivation}",
            )

        return RedirectResponse(
            f"/console/sites/{site.slug}/prices/{batch_id}"
            f"?ok={quote(f'Saved price update #{batch_id} with {len(rows)} price(s). Nothing is on the website yet.')}",
            status_code=303,
        )

    return router
