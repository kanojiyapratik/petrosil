"""The AI price update, as steps: read the reports, correct a row, draft, save.

These were the bodies of the console's form handlers (routes_reading.py and
routes_editorial.py), moved here unchanged so a second caller -- the app's
AI tools tab, through app/console/engine_api.py -- runs exactly the same
work. The console's screens call these too, so there is one implementation
of every step and the console's tests hold both callers to it.

Nothing here knows about HTML, forms or redirects. A step that cannot go on
raises FlowError with the words the editor should see and the HTTP status
the console always answered with; each caller turns that into its own reply.
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime

from ..editorial.benchmarks import benchmark_prompt, merge_benchmarks
from ..editorial.fx import FrankfurterRates, convert_rows
from ..editorial.preflight import preflight
from ..editorial.reading import parse_reading, reading_prompt, split_for_reading
from ..editorial.review import (
    ParsedSuggestions,
    build_rows,
    editorial_prompt,
    flag_unsupported,
    flag_went_missing,
    parse_suggestions,
    reject_out_of_scale,
    unsupported_by_evidence,
)
from ..editorial.rounding import apply_rounding
from ..editorial.rules import apply_rules, benchmark_names
from ..editorial.secondlook import merge_second_look, missed_locations, second_look_prompt
from ..editorial.workings import export_columns, workings_for
from .site_client import SiteError

MAX_DOCUMENTS = 5
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

IMAGE_PROMPT = (
    "Transcribe every price table and price figure in these images as "
    "plain text. Keep all company names, grades, viscosities and numbers "
    "exactly as shown, one line per row, with column labels. Start each "
    "table with its title and say which currency every column is in "
    "(e.g. 'Local currency/t' and '$/t' side by side are two different "
    "prices for the same row) -- a figure without its currency is useless."
)

# The sign printed in front of a figure on the editorial screen. Only the
# four this client actually publishes in get a symbol; anything else prints
# its three-letter code, because a wrong symbol is worse than no symbol and
# "¥" cannot tell yen from yuan. Matches app/console/routes_rules.py's
# _SYMBOL, with GBP added for Southern UK.
_MONEY_SIGN = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹"}

# The shape the screen and the prompt both ask for. It is only the shape:
# "2026-13-01" and "2026-02-31" match it and are not days, so the calendar
# itself has the last word below.
_ISO_SHAPE = re.compile(r"\d{4}-\d{2}-\d{2}")


class FlowError(Exception):
    """A step that cannot go on: what to tell the editor, and the status the
    console has always answered with. `reuse` is set only when the reading
    was already used -- it carries what a "use these prices again" button
    needs."""

    def __init__(self, message: str, status: int, reuse: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.reuse = reuse


def money_sign(code: str | None) -> str:
    """"$", "€", "₹" -- or "ZAR " for a currency with no sign of its own.

    Never raises on an unexpected code: an unknown currency is a figure the
    editor still has to read, and a bare number is worse than a prefix.
    """
    if not code:
        return ""

    code = str(code).strip().upper()

    return _MONEY_SIGN.get(code, f"{code} ")


def _figure(value: float) -> str:
    """A checked figure as the report printed it, not as a float repr."""
    return f"{float(value):.4f}".rstrip("0").rstrip(".") or "0"


def plausible_timestamp(value: str) -> bool:
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


def digest_line(row) -> str:
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


def is_a_day(text: str) -> bool:
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


@dataclass
class Engine:
    """Everything a step needs, handed over once by whoever mounts it."""

    store: object
    extractions: object = None
    driver: object = None
    default_model: str = ""
    driver_for: object = None
    usage: object = None
    rules: object = None
    fx: object = None
    rounding: object = None
    drafts: object = None

    def note_usage(self, **fields) -> None:
        # The ledger is a record of the work, never a condition of it.
        if self.usage is None:
            return

        try:
            self.usage.record(**fields)
        except Exception:  # noqa: BLE001
            pass

    def model_for(self, slug: str):
        """(driver, chosen, model, provider name) for this site's runs."""
        chosen = self.driver_for(slug) if self.driver_for is not None else None
        active = chosen or self.driver
        model = getattr(chosen, "model", self.default_model) if chosen is not None else self.default_model
        provider_name = getattr(chosen or self.driver, "provider_key", "gemini")

        return active, chosen, model, provider_name


# --------------------------------------------------------------- reading


@dataclass
class ReadResult:
    reading: object
    failures: list[str] = field(default_factory=list)


def read_reports(
    engine: Engine,
    site,
    actor: str,
    bodies: list[tuple[str, bytes]],
    instructions: str | None,
    *,
    document_to_text,
    document_images,
    pdf_needs_password,
) -> ReadResult:
    """Step one: each uploaded report read on its own.

    One AI call per file. A single prompt holding five reports runs to 65k
    characters and gets skimmed -- measured on the 19.08 Lube Report, where
    gpt-4o-mini returned nothing at all across 47 locations. A file that
    fails costs that file, and says so.

    The three readers arrive as arguments so the console's tests can stand
    in for them where they always have, in routes_reading.
    """
    extractions = engine.extractions
    active, chosen, model, provider_name = engine.model_for(site.slug)
    note_usage = engine.note_usage

    # Kept as it was sent, not as it is saved: the rulebook is edited in
    # place, so a week later console_sites no longer says what this run
    # saw. "Did the model disobey, or was it never told?" is now a
    # question with an answer.
    reading = extractions.open_set(site.slug, actor, instructions)
    failures: list[str] = []

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

    engine.store.record(
        actor, "read reports", site.slug, f"{len(bodies)} file(s), reading #{reading.id}"
    )

    return ReadResult(reading=reading, failures=failures)


def check_row_fields(form_data) -> tuple[dict | None, str | None]:
    """One row's worth of hand-typed figures, or the reason to refuse them.

    Shared by the correction form and the add-a-row form, so a row the
    editor types is held to exactly what a row the editor corrects is.
    `form_data` is anything with .get() and `in`: a posted form, or a dict
    in which "kept" is present only when the row is kept, as a checkbox is.
    """

    def numeric(name: str) -> float | None:
        raw = form_data.get(name)
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

    def optional(name: str) -> str | None:
        value = form_data.get(name)
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

    if date_text and not is_a_day(date_text):
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


# ---------------------------------------------------------------- drafting


def draft_prices(
    engine: Engine,
    site,
    actor: str,
    client,
    *,
    set_id: int,
    pricedate: str,
    again: bool = False,
    held: str = "",
) -> dict:
    """Step two: the checked figures become a per-location draft.

    Three model passes (the draft, the benchmarks, a second look at what the
    first skipped), then code does every sum: currency, the rulebook,
    rounding, the out-of-scale and evidence checks, the workings and the
    preflight. The draft is kept before anyone sees it.
    """
    extractions = engine.extractions
    usage = engine.usage
    rules = engine.rules
    rounding = engine.rounding
    drafts = engine.drafts
    fx = engine.fx
    instructions = site.editorial_instructions or ""

    # The set must belong to this site -- the same guard the reading
    # screens carry. Without it, a set_id for another site's reading
    # would be analysed against this site's locations and then closed.
    reading = extractions.set_by_id(set_id)

    if reading is None or reading.site_slug != site.slug:
        raise FlowError("That reading could not be found.", 404)

    def already_used():
        # Re-read: when a concurrent submit won the claim, the copy
        # fetched at the top of this request says used_at is still
        # empty, and a reuse button drawn from it would be stale the
        # moment it was rendered.
        current = extractions.set_by_id(set_id) or reading

        return FlowError(
            "Those prices have already been used.",
            409,
            reuse={"set_id": set_id, "pricedate": pricedate, "used_at": str(current.used_at or "")},
        )

    # The cheap first word. It is not the guard -- the claim below is
    # -- but it keeps a plain double-submit off the site's API.
    if reading.used_at is not None and not again:
        raise already_used()

    # Only the rows the editor left ticked -- the reading step is
    # where a figure gets corrected or dropped, never here.
    kept_rows = [row for row in extractions.rows_for(set_id) if row.kept]

    if not kept_rows:
        raise FlowError("Nothing was kept from that reading. Check some prices first.", 422)

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
        locations = client.locations().get("data", [])
    except SiteError as error:
        raise FlowError(str(error), 502) from error

    names = [str(entry.get("title") or "") for entry in locations if entry.get("title")]
    current = {
        str(entry["title"]): float(entry["latest_price"])
        for entry in locations
        if entry.get("title") and entry.get("latest_price") is not None
    }
    # The currency each location is priced in, when the site says so.
    # A site that does not is treated as all-dollar, as before.
    home = {
        str(entry["title"]): str(entry["currency"])
        for entry in locations
        if entry.get("title") and entry.get("currency")
    }

    if not names:
        raise FlowError(f"{site.name} reported no live locations to draft prices for.", 502)

    active, chosen, model, provider_name = engine.model_for(site.slug)

    # A held value that could never match reclaim_set's compare -- not
    # merely stale, but not a timestamp at all -- must not reach its
    # ::timestamptz cast. Refuse it the same way a stale-but-well-formed
    # token is refused, rather than letting Postgres raise on it.
    if again and not plausible_timestamp(held):
        raise already_used()

    # The reading is spent HERE, before the first model call and in a
    # single statement, so two submits arriving together cannot both
    # pass a check and both buy a full draft. Reading used_at and
    # deciding minutes earlier was never a guard, only a hint.
    claimed = extractions.reclaim_set(set_id, held) if again else extractions.claim_set(set_id)

    if not claimed:
        raise already_used()

    engine.store.record(actor, "used a reading", site.slug, f"reading #{set_id}")

    # Report benchmarks: figures the rulebook derives from that are not
    # site locations ("Report: FOB Asia SN 150"). Asked of the model like
    # any location, shown separately, never staged.
    site_rules = rules.for_site(site.slug) if rules is not None else []
    benchmarks = benchmark_names(site_rules, names)
    asked = names + benchmarks

    try:
        prompt = editorial_prompt(asked, [], instructions or None, evidence=evidence)
        completion = active.generate(prompt) if chosen is not None else active.generate(model, prompt)
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

        raise FlowError(str(error), 502) from error

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
    # Built whether or not this site has benchmarks: the second look
    # below reads the same lines.
    digest = "\n".join(digest_line(row) for row in kept_rows)

    if digest and benchmarks:
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

    # The locations the main pass skipped, asked once more on their
    # own -- the same enumerate-and-fill shape as the benchmarks.
    # See app/editorial/secondlook.py for what made this necessary.
    # A location the rulebook fills is never asked: a figure here
    # would occupy the row and apply_rules would then stay silent.
    missed = missed_locations(
        names, parsed, {rule.derived_location for rule in site_rules if rule.enabled}
    )

    if digest and missed:
        try:
            again_prompt = second_look_prompt(missed, digest, instructions or None)
            second = (
                active.generate(again_prompt)
                if chosen is not None
                else active.generate(model, again_prompt)
            )

            if usage is not None:
                usage.record(
                    kind="editorial_second_look", provider=provider_name, model=model,
                    status=second.status, prompt_tokens=second.prompt_tokens,
                    completion_tokens=second.completion_tokens, site_slug=site.slug,
                )

            if second.status == "complete":
                parsed = merge_second_look(
                    parsed, parse_suggestions(second.text, missed), missed
                )
        except Exception:  # noqa: BLE001 - a second look is a bonus, never the draft
            if usage is not None:
                usage.record(
                    kind="editorial_second_look", provider=provider_name, model=model,
                    status="failed", site_slug=site.slug,
                )

    rows = build_rows(asked, current, parsed)

    # The locations the editor has marked "take the figure as
    # printed": UK South, where Argus prints pounds and his published
    # euro price is that same number. Read once -- the evidence check
    # and the conversion below must agree about which they are, or a
    # figure left in its printed currency on purpose is flagged for
    # being in its printed currency.
    as_printed = (
        rounding.as_printed_for_site(site.slug)
        if rounding is not None and hasattr(rounding, "as_printed_for_site")
        else set()
    )

    # Figures the checked reports never printed -- checked now, while
    # every row still holds the figure the model returned.
    unsupported = unsupported_by_evidence(rows, evidence, as_printed)

    # A figure printed in another currency becomes the location's own
    # currency (dollars, unless the site says otherwise) at the rate
    # for its own date before any rule sees it; no rate, no
    # conversion, and the rule below it stays silent. A rupee figure
    # for a rupee location is left as printed. See app/editorial/fx.py.
    rows = convert_rows(
        rows,
        fx if fx is not None else FrankfurterRates(),
        pricedate,
        home=home,
        as_printed=as_printed,
    )

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
        (site.round_to_nearest, getattr(site, "round_direction", "nearest")),
        rounding.for_site(site.slug) if rounding is not None else None,
    )

    # A figure far off the scale of this location (or the site's other
    # prices) is not offered at all -- Vietnam CFR FOB at 13.
    rows = reject_out_of_scale(rows, current, home)

    # Last, so neither conversion nor rounding can clear the flag.
    rows = flag_unsupported(rows, unsupported)

    # A location that was priced from the reports last time and is
    # empty now: the reading may have dropped the line, as it dropped
    # Taiwan FOB on 15.10.2026. After the rules, so a location a rule
    # filled is not called missing.
    rows = flag_went_missing(
        rows,
        drafts.priced_last_time(site.slug)
        if drafts is not None and hasattr(drafts, "priced_last_time")
        else set(),
    )

    # Every figure on this screen is in its own location's currency,
    # and "565" beside "565" is unreadable when one is euros and the
    # other dollars (Italy Domestic and Italy FOB, on the same draft).
    # A row still printed as the report had it carries its own
    # currency; a converted one is in the location's home currency.
    # Carried on the row so the saved draft shows it too.
    for row in rows:
        row["money"] = money_sign(row.get("currency") or home.get(row["location"], "USD"))

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

    # The draft is kept before the editor sees it: the AI's figures,
    # its reasoning and every row, ticked or not. Saving then fills in
    # what the editor kept and at what price. See DraftStore.
    draft_id = (
        drafts.create(
            site_slug=site.slug, created_by=actor, rows=rows,
            benchmark_rows=benchmark_rows, reading_set_id=set_id,
            price_date=pricedate, provider=provider_name, model=model,
            analysis_status=completion.status,
            # What this analyse run was told. Recorded beside the
            # prices it produced, because the two are only
            # explicable together.
            instructions=instructions or None,
        )
        if drafts is not None
        else None
    )

    # Every figure, with the arithmetic that produced it. Attached to
    # the row, so it rides into the draft's `detail` and can leave
    # again as the sheet the client reads beside the report -- the
    # rows they queried in all four October rounds were the ones
    # whose figure is printed nowhere in it. See
    # app/editorial/workings.py.
    rounding_overrides = rounding.for_site(site.slug) if rounding is not None else None
    site_default = (site.round_to_nearest, getattr(site, "round_direction", "nearest"))
    by_location = {row["location"]: row for row in rows + benchmark_rows}

    for row in rows + benchmark_rows:
        row["workings"] = workings_for(
            row,
            by_location=by_location,
            rules=site_rules,
            default_step=site_default,
            overrides=rounding_overrides,
        ).line

    # Last of all, once every figure on the draft is final: ask the
    # sheet whether it contradicts itself. Four rounds of mismatch
    # files with the client in October 2026 were all explained by
    # faults this finds without leaving the machine -- a derived
    # price off its own rule, a figure rounded the wrong way, a price
    # outside the range it was quoted from, a run built on last
    # week's issue. See app/editorial/preflight.py.
    findings = preflight(
        rows + benchmark_rows,
        rules=site_rules,
        default_step=site_default,
        overrides=rounding_overrides,
        price_date=pricedate,
    )

    return {
        "draft_id": draft_id,
        "rows": rows,
        "benchmarks": [row for row in benchmark_rows if row["status"] == "suggested"],
        "summary": summary,
        "findings": findings,
        "blockers": sum(1 for f in findings if f.severity == "blocker"),
        # What this run was told, shown beside what it produced.
        "instructions_used": instructions or None,
        "pricedate": pricedate,
        "benchmark_note": benchmark_note,
        "analysis": {
            "status": completion.status,
            "model": model,
            "error": completion.error,
        },
    }


# ------------------------------------------------------------------ saving


def save_draft(
    engine: Engine,
    site,
    actor: str,
    client,
    *,
    rows: list[dict],
    derivations: list[str],
    pricedate: str,
    draft_id: int | None,
) -> tuple[int | None, int]:
    """Step three: the rows the editor kept become a draft price update on
    the site -- nothing is published yet. Returns (batch id, rows saved).

    `rows` are {"location", "price"}; `derivations` the "location = price:
    formula" lines for the prices a rule produced, each recorded on its own.
    """
    if not rows:
        raise FlowError("Tick at least one row with a price to stage.", 422)

    try:
        result = client.stage_rows(rows, price_date=pricedate, source="editorial")
    except SiteError as error:
        raise FlowError(str(error), 502) from error

    batch_id = result.get("batch", {}).get("id")
    drafts = engine.drafts

    # Link the saved update back to the AI's draft: which rows were kept
    # and at what price, so an AI figure and the editor's change to it
    # stay distinguishable. A form without a usable id saves as before.
    linked = draft_id is not None and drafts is not None and drafts.mark_saved(
        draft_id, site.slug, batch_id=batch_id, saved_by=actor,
        prices={row["location"]: row["price"] for row in rows},
    )

    engine.store.record(
        actor,
        "staged an editorial update",
        site.slug,
        f"{len(rows)} row(s) to batch #{batch_id}"
        + (f", {len(derivations)} of them derived by rule" if derivations else "")
        + (f", from AI draft #{draft_id}" if linked else ""),
    )

    # One audit line per derived price: source, rule and result, kept even
    # after screens move on. "Both the source price and calculation rule
    # are recorded in the audit log" -- the owner's requirement, verbatim.
    for derivation in derivations:
        engine.store.record(
            actor, "saved a derived price", site.slug, f"batch #{batch_id}: {derivation}"
        )

    return batch_id, len(rows)


def workings_sheet(draft) -> str:
    """The draft as a sheet that argues for itself, as CSV text.

    One line per published price: the figure, the report it came from, the
    range that report printed, every step of the arithmetic, and whether
    those steps reach the figure. This is what goes to the client instead of
    a bare column of numbers -- the rows queried in all four October rounds
    were the ones whose figure appears nowhere in the report, and a row that
    explains itself is not queried.
    """
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=export_columns(), extrasaction="ignore")
    writer.writeheader()

    for row in draft.rows:
        if row.is_benchmark or row.suggested_price is None:
            continue

        detail = row.detail or {}
        writer.writerow(
            {
                "Location": row.location,
                "Published": row.suggested_price,
                "Source": row.source or "",
                "Report date": detail.get("price_date") or "",
                "Quoted low": row.suggested_min,
                "Quoted high": row.suggested_max,
                "Workings": detail.get("workings") or row.rationale or "",
                # A draft kept before this column existed has no workings
                # to check, and saying "no" would read as a fault.
                "Checks out": "" if not detail.get("workings") else "yes",
            }
        )

    return buffer.getvalue()
