"""The AI editorial update: the one screen where market reports become prices.

The owner's design: the console is the single place an editor works, for every
site. Reports are uploaded here; the site's current prices come in over its
API; the model drafts a per-location suggestion; the editor reviews the draft
here and stages the rows they keep back onto the site -- again over its API --
as a normal draft batch, committed from the existing batch screen. The site
gains no UI and the module still holds no site database credentials.
"""

from __future__ import annotations

from datetime import date, datetime
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..db.store import Store, StoredSite
from ..editorial.benchmarks import benchmark_prompt, merge_benchmarks
from ..editorial.fx import FrankfurterRates, convert_rows
from ..editorial.review import ParsedSuggestions, build_rows, editorial_prompt, parse_suggestions
from ..editorial.rounding import apply_rounding
from ..editorial.rules import apply_rules, benchmark_names
from .access import make_site_guard
from .routes import tone_for
from .site_client import SiteClient, SiteError

MAX_DOCUMENTS = 5
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024


def _figure(value: float) -> str:
    """A checked figure as the report printed it, not as a float repr."""
    return f"{float(value):.4f}".rstrip("0").rstrip(".") or "0"


def _plausible_timestamp(value: str) -> bool:
    """A guard before a reuse token reaches reclaim_set's ``::timestamptz`` cast.

    The button always carries exactly what this screen itself rendered, but
    a hand-crafted request, stale or corrupted form state, or a browser
    extension can send again=1 with a used_at that is missing, blank or
    plain garbage. Postgres raises on a bad cast into a timestamp -- an
    unhandled 500 -- so this is checked first. A value that merely looks
    like a timestamp but is stale still reaches the database and fails the
    compare-and-swap there, exactly as it always has.
    """
    if not value:
        return False

    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False

    return True


def _digest_line(row) -> str:
    """One checked row, whole, for the focused benchmark pass.

    That pass is asked to fill in "the range printed" and, for a benchmark in
    another currency, "the date the report gives for it". A line of name,
    single figure and currency carried neither: a benchmark printed
    1,450-1,500 arrived as the one number 1450, and a lira benchmark lost its
    assessment date -- which left price_date empty, sent convert_rows to the
    editor's price date instead, and picked today's ECB rate.
    """
    if row.price_min is not None and row.price_max is not None and row.price_min != row.price_max:
        figure = f"{_figure(row.price_min)}-{_figure(row.price_max)}"
    else:
        figure = _figure(row.price)

    parts = [row.name, figure, row.currency or "", row.unit or "", row.basis or ""]

    if row.price_date:
        parts.append(f"dated {row.price_date}")

    return " ".join(part for part in parts if part)


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

        return screen(
            request, user, site,
            {
                "error": request.query_params.get("err"),
                "flash": flash,
                "waiting": waiting,
                "spent": spent,
                "batches": [
                    {**batch, "tone": tone_for(batch.get("status"))} for batch in batches
                ],
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

    if extractions is not None:

        @router.post("/console/sites/{slug}/editorial/analyse", response_class=HTMLResponse)
        async def analyse(request: Request, slug: str):
            user, site, response = guard(request, slug)

            if response is not None:
                return response

            form_data = await request.form()
            pricedate = str(form_data.get("pricedate") or "").strip() or date.today().isoformat()
            instructions = site.editorial_instructions or ""

            try:
                set_id = int(str(form_data.get("set_id") or "").strip())
            except ValueError:
                return screen(
                    request, user, site, {"error": "That reading could not be found."}, 404
                )

            # The set must belong to this site -- the same guard
            # routes_reading.py's `check` and `edit_row` already carry.
            # Without it, a set_id for another site's reading would be
            # analysed against this site's locations and then closed.
            reading = extractions.set_by_id(set_id)

            if reading is None or reading.site_slug != site.slug:
                return screen(
                    request, user, site, {"error": "That reading could not be found."}, 404
                )

            # The editor asked, on the refusal screen below, to use these
            # checked prices a second time -- a staging failure or a closed
            # tab loses the draft, and the reports themselves are not kept,
            # so without this the only way back is re-uploading five files
            # and retyping every correction.
            again = str(form_data.get("again") or "").strip() == "1"
            # The used_at the reuse button was drawn with. reclaim_set swaps
            # only that exact value, so a refresh or a back-forward re-POST of
            # this form arrives stale and buys nothing.
            held = str(form_data.get("used_at") or "")

            def already_used():
                # Re-read: when a concurrent submit won the claim, the copy
                # fetched at the top of this request says used_at is still
                # empty, and a reuse button drawn from it would be stale the
                # moment it was rendered.
                current = extractions.set_by_id(set_id) or reading

                return screen(
                    request, user, site,
                    {
                        "error": "Those prices have already been used.",
                        "reuse": {
                            "set_id": set_id,
                            "pricedate": pricedate,
                            "used_at": str(current.used_at or ""),
                        },
                    },
                    409,
                )

            # The cheap first word. It is not the guard -- the claim below is
            # -- but it keeps a plain double-submit off the site's API.
            if reading.used_at is not None and not again:
                return already_used()

            # Only the rows the editor left ticked -- the reading step is
            # where a figure gets corrected or dropped, never here.
            kept_rows = [row for row in extractions.rows_for(set_id) if row.kept]

            if not kept_rows:
                return screen(
                    request, user, site,
                    {"error": "Nothing was kept from that reading. Check some prices first."},
                    422,
                )

            evidence = [
                {
                    "name": row.name, "price": row.price, "price_min": row.price_min,
                    "price_max": row.price_max, "currency": row.currency, "unit": row.unit,
                    "basis": row.basis, "price_date": row.price_date, "note": row.note,
                    "filename": row.filename,
                }
                for row in kept_rows
            ]

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
                    {"error": f"{site.name} reported no live locations to draft prices for."},
                    502,
                )

            chosen = driver_for() if driver_for is not None else None
            active = chosen or driver
            model = getattr(chosen, "model", default_model) if chosen is not None else default_model

            provider_name = getattr(chosen or driver, "provider_key", "gemini")

            # A held value that could never match reclaim_set's compare -- not
            # merely stale, but not a timestamp at all -- must not reach its
            # ::timestamptz cast. Refuse it the same way a stale-but-well-formed
            # token is refused, rather than letting Postgres raise on it.
            if again and not _plausible_timestamp(held):
                return already_used()

            # The reading is spent HERE, before the first model call and in a
            # single statement, so two submits arriving together cannot both
            # pass a check and both buy a full draft. Reading used_at and
            # deciding minutes earlier was never a guard, only a hint.
            claimed = (
                extractions.reclaim_set(set_id, held) if again
                else extractions.claim_set(set_id)
            )

            if not claimed:
                return already_used()

            store.record(user.email, "used a reading", site.slug, f"reading #{set_id}")

            # Report benchmarks: figures the rulebook derives from that are not
            # site locations ("Report: FOB Asia SN 150"). Asked of the model like
            # any location, shown separately, never staged.
            site_rules = rules.for_site(site.slug) if rules is not None else []
            benchmarks = benchmark_names(site_rules, names)
            asked = names + benchmarks

            try:
                prompt = editorial_prompt(asked, [], instructions or None, evidence=evidence)
                completion = (
                    active.generate(prompt)
                    if chosen is not None
                    else active.generate(model, prompt)
                )
            except Exception as error:  # noqa: BLE001 - a provider failure is a screenful, not a 500
                if usage is not None:
                    usage.record(
                        kind="editorial", provider=provider_name, model=model,
                        status="failed", site_slug=site.slug,
                    )

                # No draft was produced, so nothing was used: the reading goes
                # back to waiting. Otherwise a 502 and a closed tab left five
                # reports read and paid for with no route back to them.
                extractions.release_set(set_id)

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

            # The benchmarks get a second, focused reading: only the checked
            # figures, only the benchmark names, one answer per name. See
            # app/editorial/benchmarks.py for why this pass exists. Every
            # checked row is already a price line -- price_digest()'s job is
            # finding price-bearing lines inside a whole report, which is not
            # what this is; running it here would silently drop a row with no
            # currency (its PRICE_LINE regex has nothing to match without a
            # currency symbol, a "/t" unit or a currency code), so the lines
            # are joined directly instead.
            benchmark_note = None
            digest = "\n".join(_digest_line(row) for row in kept_rows) if benchmarks else ""

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

            # The client's rulebook rounds nearly every price it derives from
            # a report ("round off closest multiple of 5"). Applied last, so
            # a direct price, a converted price and a derived price all land
            # on the same grid before the editor sees them. See
            # app/editorial/rounding.py.
            rows = apply_rounding(
                rows,
                site.round_to_nearest,
                rounding.for_site(site.slug) if rounding is not None else None,
            )

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
                "needs_rate": sum(
                    1 for row in benchmark_rows + rows if row["status"] == "needs_rate"
                ),
                "no_evidence": sum(1 for row in rows if row["status"] == "no_evidence"),
                "invalid": sum(1 for row in rows if row["status"] == "invalid"),
                "flagged": sum(1 for row in rows if row["flag"] is not None),
                "dropped_unknown": len(parsed.unmatched) - near_matches,
            }

            return screen(
                request, user, site,
                {
                    "rows": rows,
                    "benchmarks": [row for row in benchmark_rows if row["status"] == "suggested"],
                    "summary": summary,
                    "pricedate": pricedate,
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
