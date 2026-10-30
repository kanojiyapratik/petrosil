# Two-Step Editorial Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the editorial update into two steps — each uploaded report is read by the AI on its own and its findings shown as printed for the editor to check, then the kept findings from every report go to the AI together for the analysis that produces the price draft.

**Architecture:** A new `app/editorial/reading.py` holds the per-file prompt and its parser, producing rows in the report's own words (name, figure, currency, unit, basis, date) with no matching, no FX and no arithmetic. A new store (`ExtractionStore`) keeps a reading set and its rows in Postgres so step 1 survives a page reload. A new `routes_reading.py` serves step one (read the files, check a row); `routes_editorial.py` loses its one-step draft handler and gains an analyse route that reads the checked rows instead of raw document text. Everything downstream of the analysis call (`build_rows`, near-match pairing, benchmarks, FX, rules, staging, commit) is untouched.

**Tech Stack:** Python 3.12, FastAPI, Jinja2, psycopg/Postgres, pytest. No new dependencies.

**Spec:** `docs/specs/2026-09-10-two-step-editorial-upload.md`

## Global Constraints

- **Up to 5 files, each ≤ 10 MB.** `MAX_DOCUMENTS = 5` and `MAX_DOCUMENT_BYTES = 10 * 1024 * 1024` in `app/console/routes_editorial.py` — do not change either.
- **Formats:** docx, xlsx, pdf, txt, read by the existing `document_to_text` / `document_images` in `app/editorial/extract.py`. Add no parser.
- **No new dependencies.** `requirements.txt` does not gain a line.
- **Step 1 output is as printed.** No matching to site locations, no FX conversion, no rules, no midpoints, no arithmetic of any kind in step 1.
- **Code computes every number the editor acts on.** The model proposes and narrates; it never does arithmetic that reaches a price.
- **Every model call is recorded** through `usage.record(kind=..., provider=..., model=..., status=..., prompt_tokens=..., completion_tokens=..., site_slug=...)`, and a failure to record must never break the work. New kinds: `extract_file`, `extract_file_images`.
- **A provider failure is a screenful, not a 500.** Follow the existing `try/except Exception` + `screen(...)` pattern in `routes_editorial.py`.
- **Screen wording** uses the owner's vocabulary: **read**, **check**, **use**. Never "derived", "benchmark", "rulebook", "extraction", "parse" in anything a person sees.
- **Migrations are append-only.** Add new `Migration` entries at the end of `MIGRATIONS` in `app/db/migrate.py`; never edit an existing one.
- **Run the tests** with `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests -q -p no:cacheprovider` — there is no native Python on this machine.
- **Suite is 357 green before this plan starts.** It must be green at the end of every task.

---

## File Structure

**Created:**
- `app/editorial/reading.py` — the per-file prompt, the parser for its answer, and the `ReadRow` shape. Pure functions, no I/O, no database.
- `app/console/routes_reading.py` — the two step-1 routes (read the files, check and correct a row). Kept out of `routes_editorial.py`, which is already 480 lines. The analyse route stays in `routes_editorial.py`, where the rules, FX and staging it feeds already live.
- `app/templates/reading.html` — the step-1 screen: one panel per file, its rows as printed, each editable.
- `tests/test_reading.py` — the prompt and parser.
- `tests/test_extraction_store.py` — the field allowlist on a correction.
- `tests/test_reading_routes.py` — the two step-1 routes, with fakes.

**Modified:**
- `app/db/migrate.py` — one new migration, `0009_reading_sets`.
- `app/db/store.py` — `ExtractionStore`, plus the `ReadingSet` / `ReadRow` dataclasses it returns.
- `app/main.py` — build `ExtractionStore` and include the new router.
- `app/console/routes_editorial.py` — the one-step draft handler is deleted; a new analyse route takes the checked rows instead of raw document text.
- `app/editorial/review.py` — `editorial_prompt` gains an evidence form.
- `app/templates/editorial.html` — the upload form points at step 1.

---

### Task 1: The per-file reading prompt and its parser

The pure core: what one report is asked, and how its answer is read. No database, no HTTP, no provider.

**Files:**
- Create: `app/editorial/reading.py`
- Test: `tests/test_reading.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `READING_PREAMBLE: str`
  - `reading_prompt(document_text: str, filename: str, instructions: str | None = None) -> str`
  - `parse_reading(text: str | None) -> list[dict]` — each dict has keys `name`, `price`, `price_min`, `price_max`, `currency`, `unit`, `basis`, `price_date`, `note`. `name` and `price` are always present and truthy; the rest may be `None`.

- [ ] **Step 1: Write the failing tests**

```python
"""What one report is asked, and how its answer is read.

Step one reads a single report in its own words: the name as the report
writes it, the figure as printed, the currency and unit as printed. Nothing
here matches a site location, converts a currency or computes a midpoint --
that is step two's work, where every report is present at once.
"""

import json

from app.editorial.reading import parse_reading, reading_prompt


class TestWhatOneReportIsAsked:
    def test_the_report_text_is_in_the_prompt(self):
        prompt = reading_prompt("FOB Asia SN 150 1,260-1,300", "lube-report.docx")

        assert "FOB Asia SN 150 1,260-1,300" in prompt

    def test_the_prompt_names_the_file_so_the_answer_can_be_traced(self):
        assert "lube-report.docx" in reading_prompt("text", "lube-report.docx")

    def test_no_site_location_is_ever_offered_to_the_model(self):
        # The whole point of step one: one report, its own words, nothing to
        # match against. A list of locations here would invite the model to
        # guess a mapping from a single report.
        prompt = reading_prompt("text", "a.docx")

        assert "Singapore SN 150 FOB Group I" not in prompt
        assert "locations" not in prompt.lower()

    def test_the_editors_instructions_ride_along_as_guidance_only(self):
        prompt = reading_prompt("text", "a.docx", "The USA prices are in the picture")

        assert "The USA prices are in the picture" in prompt
        assert "cannot change" in prompt

    def test_the_model_is_told_to_keep_the_figure_exactly_as_printed(self):
        prompt = reading_prompt("text", "a.docx")

        assert "exactly as printed" in prompt
        assert "do not convert" in prompt.lower()


class TestReadingTheAnswer:
    def test_a_plain_answer_becomes_rows(self):
        answer = json.dumps(
            [
                {
                    "name": "Base Oil SN500 EX Kandla",
                    "price": 1560,
                    "currency": "USD",
                    "unit": "MT",
                    "basis": "FOB",
                    "price_date": "2026-08-14",
                }
            ]
        )

        rows = parse_reading(answer)

        assert rows[0]["name"] == "Base Oil SN500 EX Kandla"
        assert rows[0]["price"] == 1560.0
        assert rows[0]["currency"] == "USD"

    def test_a_range_keeps_both_ends_and_the_midpoint_is_not_computed(self):
        # Arithmetic on a price is the server's job in step two, never here.
        rows = parse_reading(
            json.dumps([{"name": "FOB Asia SN 150", "price_min": 1260, "price_max": 1300}])
        )

        assert (rows[0]["price_min"], rows[0]["price_max"]) == (1260.0, 1300.0)
        assert rows[0]["price"] == 1260.0

    def test_a_fenced_answer_is_still_read(self):
        # Models fence JSON however firmly they are told not to.
        rows = parse_reading('```json\n[{"name": "A", "price": 10}]\n```')

        assert len(rows) == 1

    def test_a_row_with_no_name_is_dropped(self):
        rows = parse_reading(json.dumps([{"price": 900}, {"name": "A", "price": 10}]))

        assert [row["name"] for row in rows] == ["A"]

    def test_a_row_with_no_usable_figure_is_dropped(self):
        rows = parse_reading(
            json.dumps([{"name": "A", "price": "n/a"}, {"name": "B", "price": 10}])
        )

        assert [row["name"] for row in rows] == ["B"]

    def test_a_zero_or_negative_figure_is_not_a_price(self):
        rows = parse_reading(json.dumps([{"name": "A", "price": 0}, {"name": "B", "price": -5}]))

        assert rows == []

    def test_a_garbled_answer_reads_as_nothing_rather_than_raising(self):
        # A silent model and a garbled one are the same outcome on screen.
        assert parse_reading("I could not find any prices.") == []
        assert parse_reading(None) == []

    def test_a_currency_is_kept_as_the_report_printed_it(self):
        rows = parse_reading(json.dumps([{"name": "Izmir", "price": 81212, "currency": "try"}]))

        assert rows[0]["currency"] == "TRY"

    def test_a_date_that_is_not_a_date_is_dropped_not_guessed(self):
        rows = parse_reading(
            json.dumps([{"name": "A", "price": 10, "price_date": "week ending Friday"}])
        )

        assert rows[0]["price_date"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests/test_reading.py -q -p no:cacheprovider`

Expected: FAIL with `ModuleNotFoundError: No module named 'app.editorial.reading'`

- [ ] **Step 3: Write the implementation**

```python
"""Reading one report, in the report's own words.

Step one of the editorial update. The model is given a single report and
asked what prices it prints -- the name as written there, the figure as
printed, the currency and unit as printed. It is given no list of site
locations, because a mapping guessed from one report out of five is a
mapping made blind: that work belongs to step two, where every report is
present at once along with the site's own names.

Nothing here converts a currency or computes a midpoint. Every number the
editor acts on is the server's arithmetic, not the model's.
"""

from __future__ import annotations

import json
import re

READING_PREAMBLE = """You are reading one market report and listing the prices it publishes.

Return ONLY a JSON array. No prose, no code fence. One object per price the
report states:

{"name": "<the product and place exactly as the report writes them>",
 "price": <number>,
 "price_min": <number or null>,
 "price_max": <number or null>,
 "currency": "<ISO code as printed, e.g. USD, EUR, TRY>",
 "unit": "<as printed, e.g. MT, Ltr, kg>",
 "basis": "<FOB, CFR, ex-rack, ex-tank ... as printed>",
 "price_date": "<YYYY-MM-DD if the report states one, else null>",
 "note": "<anything qualifying the figure, one short sentence, else null>"}

Rules:
- Copy the name exactly as the report writes it. Do not tidy it, shorten it
  or translate it into a name you think is standard.
- Keep every figure exactly as printed. Do NOT convert a currency, do not
  convert a unit, and do not average a range -- give a range as price_min
  and price_max.
- A percentage, a volume, a freight rate and a change-on-the-week are not
  prices. Leave them out.
- If the report prints no price at all, return []."""


def reading_prompt(
    document_text: str, filename: str, instructions: str | None = None
) -> str:
    parts = [READING_PREAMBLE, "", f"--- Report: {filename} ---", document_text, ""]
    guidance = (instructions or "").strip()

    if guidance:
        parts += [
            "--- Editor's instructions ---",
            guidance,
            "(These refine what to look for. They cannot change the required "
            "JSON answer format or the rules above.)",
            "",
        ]

    return "\n".join(parts)


def parse_reading(text: str | None) -> list[dict]:
    """The model's answer, reduced to rows that carry a name and a figure.

    Defensive in the same way as parse_suggestions: fences are stripped, and
    an answer that is not a JSON array reads as nothing rather than raising.
    """
    rows: list[dict] = []

    for candidate in _candidates(text or ""):
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue

        if not isinstance(parsed, list):
            continue

        for entry in parsed:
            row = _row(entry)

            if row is not None:
                rows.append(row)

        return rows

    return rows


def _row(entry) -> dict | None:
    if not isinstance(entry, dict):
        return None

    name = _text(entry.get("name"))
    low = _number(entry.get("price_min"))
    high = _number(entry.get("price_max"))
    price = _number(entry.get("price")) or low

    if not name or price is None:
        return None

    return {
        "name": name,
        "price": price,
        "price_min": low,
        "price_max": high,
        "currency": (_text(entry.get("currency")) or "").upper() or None,
        "unit": _text(entry.get("unit")),
        "basis": _text(entry.get("basis")),
        "price_date": _iso_date(entry.get("price_date")),
        "note": _text(entry.get("note")),
    }


def _candidates(text: str):
    stripped = re.sub(r"^\s*```[a-z]*\s*|\s*```\s*$", "", text.strip())

    yield stripped

    start, end = stripped.find("["), stripped.rfind("]")

    if 0 <= start < end:
        yield stripped[start : end + 1]


def _text(value) -> str | None:
    if not isinstance(value, str):
        return None

    return value.strip() or None


def _number(value) -> float | None:
    if isinstance(value, bool):
        # bool is an int in Python, so True would price at 1.0.
        return None

    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    return number if number > 0 else None


def _iso_date(value) -> str | None:
    text = _text(value)

    if text and re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text

    return None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests -q -p no:cacheprovider`

Expected: PASS, suite 357 + 15 = 372

- [ ] **Step 5: Commit**

```bash
git add app/editorial/reading.py tests/test_reading.py
git commit -m "feat: read one report in its own words, without matching it to anything"
```

---

### Task 2: Where a reading is kept between the two steps

**Files:**
- Modify: `app/db/migrate.py` (append one `Migration` to `MIGRATIONS`)
- Modify: `app/db/store.py` (append `ReadingSet`, `ReadRow`, `ExtractionStore` after `RulesStore`)
- Test: `tests/test_extraction_store.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `ReadingSet(id: int, site_slug: str, created_by: str, created_at, files: list[str])`
  - `ReadRow(id: int, set_id: int, filename: str, name: str, price: float, price_min: float | None, price_max: float | None, currency: str | None, unit: str | None, basis: str | None, price_date: str | None, note: str | None, kept: bool)`
  - `ExtractionStore(pool)` with `open_set(site_slug, created_by) -> ReadingSet`, `add_rows(set_id, filename, rows: list[dict]) -> None`, `set_by_id(set_id) -> ReadingSet | None`, `latest_open(site_slug) -> ReadingSet | None`, `rows_for(set_id) -> list[ReadRow]`, `update_row(row_id, **fields) -> None`, `close_set(set_id) -> None`.

- [ ] **Step 1: Write the failing tests**

**There is no database in the test image and no `conftest.py`** — every existing test in this suite runs on fakes, with no network and no Postgres, and the other stores (`RulesStore`, `ProviderStore`) have no tests at all. Do not add a database fixture; follow the house style. What is tested here is the one part of this store that is not plain SQL: `update_row` interpolates field *names* into the statement, so the allowlist that decides which names are legal has to be pinned.

```python
"""The one part of the reading store that is not plain SQL.

update_row builds its SET clause from the caller's keyword names, so the
allowlist is the only thing standing between a typo -- or worse -- and the
statement. The rest of this store is SQL the other stores' style leaves
untested; it is exercised through the routes in test_reading_routes.py.
"""

from app.db.store import ExtractionStore


class FakeConnection:
    def __init__(self, log):
        self._log = log
        self.committed = False

    def execute(self, sql, params=None):
        self._log.append((" ".join(sql.split()), params))

        return self

    def commit(self):
        self.committed = True

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class FakePool:
    def __init__(self):
        self.statements = []

    def connection(self):
        log = self.statements

        class Scope:
            def __enter__(self):
                return FakeConnection(log)

            def __exit__(self, *args):
                return False

        return Scope()


class TestCorrectingAReadRow:
    def test_a_correction_names_only_the_field_it_changes(self):
        pool = FakePool()

        ExtractionStore(pool).update_row(7, price=1650.0)

        sql, params = pool.statements[0]

        assert sql == "UPDATE console_reading_rows SET price = %s WHERE id = %s"
        assert params == (1650.0, 7)

    def test_several_fields_travel_with_their_values_in_the_same_order(self):
        pool = FakePool()

        ExtractionStore(pool).update_row(7, name="FOB Asia SN 150", kept=False)

        sql, params = pool.statements[0]

        assert sql.count("= %s") == 3  # two fields plus the id
        assert params[-1] == 7
        assert set(params[:-1]) == {"FOB Asia SN 150", False}

    def test_a_field_that_is_not_a_column_never_reaches_the_statement(self):
        # The SET clause is built from these names. Anything not on the
        # allowlist has to be dropped before it gets there.
        pool = FakePool()

        ExtractionStore(pool).update_row(7, price=10.0, site_slug="other", id=99)

        sql, _ = pool.statements[0]

        assert "site_slug" not in sql
        assert "id = %s WHERE" not in sql

    def test_a_correction_that_changes_nothing_writes_nothing(self):
        pool = FakePool()

        ExtractionStore(pool).update_row(7, nonsense="x")

        assert pool.statements == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests/test_extraction_store.py -q -p no:cacheprovider`

Expected: FAIL with `ImportError: cannot import name 'ExtractionStore'`

- [ ] **Step 3: Add the migration**

Append to `MIGRATIONS` at the end of the list in `app/db/migrate.py`:

```python
    Migration(
        id="0009_reading_sets",
        sql="""
        -- Step one of the editorial update: what the AI read out of each
        -- uploaded report, in the report's own words, waiting for the editor
        -- to check it. Kept in the database rather than in the page so that
        -- four reports read and a reload does not lose them, and so there is
        -- a record of what each report actually said.
        CREATE TABLE console_reading_sets (
          id         BIGSERIAL PRIMARY KEY,
          site_slug  TEXT NOT NULL,
          created_by TEXT NOT NULL,
          used_at    TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE console_reading_rows (
          id         BIGSERIAL PRIMARY KEY,
          set_id     BIGINT NOT NULL REFERENCES console_reading_sets(id) ON DELETE CASCADE,
          filename   TEXT NOT NULL,
          name       TEXT NOT NULL,
          price      NUMERIC NOT NULL,
          price_min  NUMERIC,
          price_max  NUMERIC,
          currency   TEXT,
          unit       TEXT,
          basis      TEXT,
          price_date DATE,
          note       TEXT,
          kept       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- A file that yielded no prices still has to appear on the screen as
        -- read, so the file list cannot be derived from the rows alone.
        CREATE TABLE console_reading_files (
          id       BIGSERIAL PRIMARY KEY,
          set_id   BIGINT NOT NULL REFERENCES console_reading_sets(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          read_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX console_reading_rows_set ON console_reading_rows (set_id);
        CREATE INDEX console_reading_sets_open ON console_reading_sets (site_slug)
            WHERE used_at IS NULL;
        """,
    ),
```

- [ ] **Step 4: Write the store**

Append to `app/db/store.py`, after `RulesStore`:

```python
@dataclass(frozen=True)
class ReadingSet:
    id: int
    site_slug: str
    created_by: str
    created_at: object
    files: list[str]


@dataclass(frozen=True)
class ReadRow:
    id: int
    set_id: int
    filename: str
    name: str
    price: float
    price_min: float | None
    price_max: float | None
    currency: str | None
    unit: str | None
    basis: str | None
    price_date: str | None
    note: str | None
    kept: bool


READ_ROW_COLUMNS = (
    "id, set_id, filename, name, price, price_min, price_max, currency, unit, "
    "basis, price_date, note, kept"
)


class ExtractionStore:
    """What step one read, kept until step two uses it.

    See app/editorial/reading.py for what a row means: the report's own
    words, no site location attached and no arithmetic applied.
    """

    def __init__(self, pool) -> None:
        self._pool = pool

    def open_set(self, site_slug: str, created_by: str) -> ReadingSet:
        with self._pool.connection() as connection:
            row = connection.execute(
                "INSERT INTO console_reading_sets (site_slug, created_by) "
                "VALUES (%s, %s) RETURNING id, site_slug, created_by, created_at",
                (site_slug, created_by),
            ).fetchone()
            connection.commit()

        return ReadingSet(
            id=int(row[0]), site_slug=row[1], created_by=row[2], created_at=row[3], files=[]
        )

    def add_rows(self, set_id: int, filename: str, rows: list[dict]) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "INSERT INTO console_reading_files (set_id, filename) VALUES (%s, %s)",
                (set_id, filename),
            )

            for row in rows:
                connection.execute(
                    "INSERT INTO console_reading_rows (set_id, filename, name, price, "
                    "price_min, price_max, currency, unit, basis, price_date, note) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        set_id, filename, row["name"], row["price"], row.get("price_min"),
                        row.get("price_max"), row.get("currency"), row.get("unit"),
                        row.get("basis"), row.get("price_date"), row.get("note"),
                    ),
                )

            connection.commit()

    def set_by_id(self, set_id: int) -> ReadingSet | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT id, site_slug, created_by, created_at FROM console_reading_sets "
                "WHERE id = %s",
                (set_id,),
            ).fetchone()

            if row is None:
                return None

            files = connection.execute(
                "SELECT filename FROM console_reading_files WHERE set_id = %s ORDER BY id",
                (set_id,),
            ).fetchall()

        return ReadingSet(
            id=int(row[0]), site_slug=row[1], created_by=row[2], created_at=row[3],
            files=[entry[0] for entry in files],
        )

    def latest_open(self, site_slug: str) -> ReadingSet | None:
        with self._pool.connection() as connection:
            row = connection.execute(
                "SELECT id FROM console_reading_sets WHERE site_slug = %s AND used_at IS NULL "
                "ORDER BY id DESC LIMIT 1",
                (site_slug,),
            ).fetchone()

        return self.set_by_id(int(row[0])) if row else None

    def rows_for(self, set_id: int) -> list[ReadRow]:
        with self._pool.connection() as connection:
            rows = connection.execute(
                f"SELECT {READ_ROW_COLUMNS} FROM console_reading_rows "
                "WHERE set_id = %s ORDER BY filename, id",
                (set_id,),
            ).fetchall()

        return [
            ReadRow(
                id=int(row[0]), set_id=int(row[1]), filename=row[2], name=row[3],
                price=float(row[4]),
                price_min=float(row[5]) if row[5] is not None else None,
                price_max=float(row[6]) if row[6] is not None else None,
                currency=row[7], unit=row[8], basis=row[9],
                price_date=row[10].isoformat() if row[10] is not None else None,
                note=row[11], kept=bool(row[12]),
            )
            for row in rows
        ]

    def update_row(self, row_id: int, **fields) -> None:
        allowed = ("name", "price", "price_min", "price_max", "currency", "unit",
                   "basis", "price_date", "note", "kept")
        changes = {key: value for key, value in fields.items() if key in allowed}

        if not changes:
            return

        assignments = ", ".join(f"{key} = %s" for key in changes)

        with self._pool.connection() as connection:
            connection.execute(
                f"UPDATE console_reading_rows SET {assignments} WHERE id = %s",
                (*changes.values(), row_id),
            )
            connection.commit()

    def close_set(self, set_id: int) -> None:
        with self._pool.connection() as connection:
            connection.execute(
                "UPDATE console_reading_sets SET used_at = now() WHERE id = %s", (set_id,)
            )
            connection.commit()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests -q -p no:cacheprovider`

Expected: PASS

- [ ] **Step 6: Confirm the migration runs against the real database**

```bash
cd /d/project2026/htdocs && docker compose up -d --build module
docker logs petrosil-module --tail 20 | grep migrat
```

Expected: `applied 1 migration(s): 0009_reading_sets`

- [ ] **Step 7: Commit**

```bash
git add app/db/migrate.py app/db/store.py tests/test_extraction_store.py
git commit -m "feat: keep what step one read, so a reload cannot lose four reports"
```

---

### Task 3: Reading the uploaded files, one call each

**Files:**
- Create: `app/console/routes_reading.py`
- Create: `app/templates/reading.html`
- Modify: `app/main.py`
- Test: `tests/test_reading_routes.py`

**Interfaces:**
- Consumes: `reading_prompt`, `parse_reading` (Task 1); `ExtractionStore`, `ReadingSet`, `ReadRow` (Task 2); the existing `document_to_text`, `document_images` from `app/editorial/extract.py`; `MAX_DOCUMENTS`, `MAX_DOCUMENT_BYTES` from `app/console/routes_editorial.py`.
- Produces: `create_reading_routes(*, store, extractions, templates, current_user, driver, default_model, driver_for=None, usage=None) -> APIRouter` serving `POST /console/sites/{slug}/reading`, `GET /console/sites/{slug}/reading/{set_id}`, `POST /console/sites/{slug}/reading/{set_id}/rows/{row_id}`.

- [ ] **Step 1: Write the failing tests**

```python
"""Reading the uploaded reports, one AI call per file.

The reason the calls are separate: a single prompt holding five reports is
65k characters and gets skimmed -- measured, gpt-4o-mini returned 0
suggestions across 47 locations. One report per call is small enough to be
read properly, and it makes plain which file gave what.
"""

import io
import json

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.ai.providers import AiCompletion, AiProviderError
from app.console.routes_reading import create_reading_routes
from app.db.store import ReadingSet, ReadRow, StoredSite

SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
)

ANSWER = json.dumps([{"name": "FOB Asia SN 150", "price": 1260, "currency": "USD"}])


class FakeStore:
    def site_by_slug(self, slug):
        return SITE if slug == SITE.slug else None

    def record(self, *args, **kwargs):
        pass


class FakeExtractions:
    def __init__(self):
        self.sets = {}
        self.added = []
        self.updated = []
        self._next = 1

    def open_set(self, site_slug, created_by):
        made = ReadingSet(
            id=self._next, site_slug=site_slug, created_by=created_by,
            created_at=None, files=[],
        )
        self.sets[self._next] = made
        self._next += 1

        return made

    def add_rows(self, set_id, filename, rows):
        self.added.append((filename, rows))

    def set_by_id(self, set_id):
        return self.sets.get(set_id)

    def rows_for(self, set_id):
        return [
            ReadRow(
                id=index + 1, set_id=set_id, filename=filename, name=row["name"],
                price=row["price"], price_min=None, price_max=None,
                currency=row.get("currency"), unit=None, basis=None,
                price_date=None, note=None, kept=True,
            )
            for index, (filename, rows) in enumerate(self.added)
            for row in rows
        ]

    def update_row(self, row_id, **fields):
        self.updated.append((row_id, fields))


class StubDriver:
    provider_key = "openai"
    model = "gpt-4o-mini"

    def __init__(self, answers=None, raises=None):
        self._answers = list(answers or [ANSWER])
        self._raises = raises
        self.prompts = []

    def generate(self, prompt):
        self.prompts.append(prompt)

        if self._raises:
            raise self._raises

        text = self._answers.pop(0) if self._answers else ANSWER

        return AiCompletion(
            status="complete", text=text, prompt_tokens=1, completion_tokens=1, error=None,
        )


def build(driver=None, extractions=None):
    extractions = extractions or FakeExtractions()
    app = FastAPI()
    app.include_router(
        create_reading_routes(
            store=FakeStore(),
            extractions=extractions,
            templates=Jinja2Templates(directory="app/templates"),
            current_user=lambda request: type(
                "U", (), {"email": "admin@local.test", "name": "Admin", "is_admin": True}
            )(),
            driver=driver or StubDriver(),
            default_model="gpt-4o-mini",
            driver_for=lambda: driver or StubDriver(),
        )
    )

    return TestClient(app), extractions


def upload(client, files):
    return client.post(
        "/console/sites/baseoil/reading",
        files=[("documents", (name, io.BytesIO(body), "text/plain")) for name, body in files],
        follow_redirects=False,
    )


class TestReadingEachFileOnItsOwn:
    def test_each_file_is_one_call_with_only_its_own_text_in_it(self):
        driver = StubDriver(answers=[ANSWER, ANSWER])
        client, _ = build(driver)

        upload(client, [("first.txt", b"FOB Asia SN 150 1260"), ("second.txt", b"Izmir 81212")])

        assert len(driver.prompts) == 2
        assert "FOB Asia SN 150 1260" in driver.prompts[0]
        assert "Izmir" not in driver.prompts[0]

    def test_the_rows_are_stored_under_the_file_they_came_from(self):
        client, extractions = build()

        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        assert extractions.added[0][0] == "lube.txt"
        assert extractions.added[0][1][0]["name"] == "FOB Asia SN 150"

    def test_a_file_the_model_found_nothing_in_is_still_recorded_as_read(self):
        client, extractions = build(StubDriver(answers=["[]"]))

        upload(client, [("empty.txt", b"no prices here")])

        assert extractions.added == [("empty.txt", [])]

    def test_one_unreadable_file_does_not_lose_the_others(self):
        # Four good reports must not be thrown away by the fifth failing.
        class Flaky(StubDriver):
            def generate(self, prompt):
                if "second" in prompt:
                    raise AiProviderError("provider is down")

                return super().generate(prompt)

        client, extractions = build(Flaky(answers=[ANSWER, ANSWER]))

        response = upload(
            client, [("first.txt", b"FOB Asia SN 150 1260"), ("second.txt", b"x")]
        )

        assert response.status_code in (200, 303)
        assert extractions.added[0][0] == "first.txt"

    def test_more_than_five_files_is_refused(self):
        client, extractions = build()

        response = upload(client, [(f"{n}.txt", b"x") for n in range(6)])

        assert response.status_code == 422
        assert extractions.added == []

    def test_no_file_at_all_is_refused(self):
        client, extractions = build()

        response = client.post("/console/sites/baseoil/reading", follow_redirects=False)

        assert response.status_code == 422
        assert extractions.added == []


class TestCheckingWhatWasRead:
    def test_the_screen_shows_each_file_and_its_rows(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        page = client.get("/console/sites/baseoil/reading/1").text

        assert "lube.txt" in page
        assert "FOB Asia SN 150" in page

    def test_a_figure_can_be_corrected(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "1300", "kept": "1"},
            follow_redirects=False,
        )

        assert extractions.updated[0][1]["price"] == 1300.0

    def test_a_row_can_be_dropped(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "1260"},
            follow_redirects=False,
        )

        assert extractions.updated[0][1]["kept"] is False

    def test_a_correction_that_is_not_a_number_changes_nothing(self):
        client, extractions = build()
        upload(client, [("lube.txt", b"FOB Asia SN 150 1260")])

        response = client.post(
            "/console/sites/baseoil/reading/1/rows/1",
            data={"name": "FOB Asia SN 150", "price": "about 1300", "kept": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 422
        assert extractions.updated == []


class TestTheReadingIsRecorded:
    def test_every_file_read_is_recorded_as_usage(self):
        seen = []

        class Usage:
            def record(self, **kwargs):
                seen.append(kwargs["kind"])

        app = FastAPI()
        app.include_router(
            create_reading_routes(
                store=FakeStore(),
                extractions=FakeExtractions(),
                templates=Jinja2Templates(directory="app/templates"),
                current_user=lambda request: type("U", (), {"email": "a@b.test", "name": "A", "is_admin": True})(),
                driver=StubDriver(),
                default_model="gpt-4o-mini",
                driver_for=lambda: StubDriver(),
                usage=Usage(),
            )
        )
        upload(TestClient(app), [("lube.txt", b"FOB Asia SN 150 1260")])

        assert "extract_file" in seen

    def test_a_broken_recorder_never_costs_the_reading(self):
        class Exploding:
            def record(self, **kwargs):
                raise RuntimeError("ledger down")

        app = FastAPI()
        extractions = FakeExtractions()
        app.include_router(
            create_reading_routes(
                store=FakeStore(),
                extractions=extractions,
                templates=Jinja2Templates(directory="app/templates"),
                current_user=lambda request: type("U", (), {"email": "a@b.test", "name": "A", "is_admin": True})(),
                driver=StubDriver(),
                default_model="gpt-4o-mini",
                driver_for=lambda: StubDriver(),
                usage=Exploding(),
            )
        )
        upload(TestClient(app), [("lube.txt", b"FOB Asia SN 150 1260")])

        assert extractions.added[0][0] == "lube.txt"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests/test_reading_routes.py -q -p no:cacheprovider`

Expected: FAIL with `ModuleNotFoundError: No module named 'app.console.routes_reading'`

- [ ] **Step 3: Write the routes**

Create `app/console/routes_reading.py`. Follow the shape of `routes_rules.py`: a `guard` that returns `(user, site, response)`, a `screen` helper, and per-route handlers. Key points the tests pin:

```python
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

from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..editorial.extract import document_images, document_to_text
from ..editorial.reading import parse_reading, reading_prompt
from .routes import tone_for
from .routes_editorial import MAX_DOCUMENTS, MAX_DOCUMENT_BYTES


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

    # guard(), screen() -- copy the shape from routes_rules.py

    @router.post("/console/sites/{slug}/reading")
    async def read_files(request: Request, slug: str):
        user, site, response = guard(request, slug)

        if response is not None:
            return response

        form_data = await request.form()
        uploads = [f for f in form_data.getlist("documents") if getattr(f, "filename", "")]
        instructions = (site.editorial_instructions or "").strip() or None

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
        target = f"/console/sites/{slug}/reading/{reading.id}"

        if failures:
            target += "?err=" + quote("; ".join(failures)[:400])

        return RedirectResponse(target, status_code=303)

    @router.get("/console/sites/{slug}/reading/{set_id}", response_class=HTMLResponse)
    def check(request: Request, slug: str, set_id: int):
        # guard; extractions.set_by_id -> 404 screen if None or wrong site;
        # group extractions.rows_for(set_id) by filename, in the order of
        # set.files, so a file with no rows still gets its own panel.

    @router.post("/console/sites/{slug}/reading/{set_id}/rows/{row_id}")
    async def edit_row(request: Request, slug: str, set_id: int, row_id: int):
        # guard; read name/price/price_min/price_max/currency/unit/basis/
        # price_date/note from the form; "kept" is present when the box is
        # ticked and absent when it is not.
        # A price that is not a positive number -> 422 and no write at all.
        # extractions.update_row(row_id, **fields); redirect back to check.

    return router
```

- [ ] **Step 4: Write the screen**

Create `app/templates/reading.html`, extending `base.html`. One `.panel` per file, headed by the filename and a count ("6 prices read"). Inside, a table with one row per price, each row a small form posting to `/console/sites/{{ site.slug }}/reading/{{ set.id }}/rows/{{ row.id }}` with `data-no-overlay="1"`: a text input for the name, a number input for the price, small inputs for currency/unit/basis/date, a "use this" checkbox named `kept`, and a Save button. A file with no rows shows `<div class="body empty">No prices found in this report.</div>`. At the foot of the page, a single form posting to `/console/sites/{{ site.slug }}/editorial/analyse` with a hidden `set_id`, one button: **Use these prices**, carrying `data-working-title="Working out the prices…"`.

Wording rules: the panels say **read**, the button says **use**. Never "extraction", "parsed", "derived".

- [ ] **Step 5: Wire it into the app**

In `app/main.py`, build `ExtractionStore(pool)` beside the other stores and include `create_reading_routes(...)` beside `create_editorial_routes(...)`, passing the same `driver`, `default_model`, `driver_for` and `usage` objects.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests -q -p no:cacheprovider`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/console/routes_reading.py app/templates/reading.html app/main.py tests/test_reading_routes.py
git commit -m "feat: read each report on its own and show what it said"
```

---

### Task 4: The analysis takes the checked rows instead of raw reports

**Files:**
- Modify: `app/editorial/review.py:68-92` (`editorial_prompt`)
- Modify: `app/console/routes_editorial.py:159-330`
- Modify: `app/templates/editorial.html`
- Test: `tests/test_editorial.py` (extend)

**Interfaces:**
- Consumes: `ReadRow` (Task 2), the reading routes' redirect target (Task 3).
- Produces: `editorial_prompt(locations, documents, instructions=None, evidence=None)` — when `evidence` is given it is a `list[dict]` with keys `name`, `price`, `price_min`, `price_max`, `currency`, `unit`, `basis`, `price_date`, `note`, `filename`, and it replaces the `documents` section of the prompt. `POST /console/sites/{slug}/editorial/analyse` taking `set_id`.

- [ ] **Step 1: Write the failing tests**

```python
class TestTheAnalysisReadsCheckedFiguresNotWholeReports:
    def test_the_prompt_carries_the_checked_figures(self):
        prompt = editorial_prompt(
            ["Singapore SN 150 FOB Group I"],
            [],
            None,
            evidence=[
                {
                    "name": "FOB Asia SN 150", "price": 1260.0, "price_min": 1260.0,
                    "price_max": 1300.0, "currency": "USD", "unit": "MT", "basis": "FOB",
                    "price_date": "2026-08-14", "note": None, "filename": "lube.docx",
                }
            ],
        )

        assert "FOB Asia SN 150" in prompt
        assert "1260" in prompt
        assert "lube.docx" in prompt

    def test_the_locations_are_still_the_names_to_answer_with(self):
        prompt = editorial_prompt(
            ["Singapore SN 150 FOB Group I"], [], None,
            evidence=[{"name": "FOB Asia SN 150", "price": 1260.0, "filename": "a.docx"}],
        )

        assert "Singapore SN 150 FOB Group I" in prompt

    def test_no_whole_report_text_is_sent_when_evidence_is_given(self):
        # The point of the split: the analysis reads a short checked list,
        # not 65k characters of five reports.
        prompt = editorial_prompt(
            ["A"], ["the entire text of a market report"], None,
            evidence=[{"name": "X", "price": 1.0, "filename": "a.docx"}],
        )

        assert "the entire text of a market report" not in prompt

    def test_without_evidence_the_prompt_is_unchanged(self):
        # The headless POST /api/editorial-reviews still sends documents.
        prompt = editorial_prompt(["A"], ["report text"], None)

        assert "report text" in prompt
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests/test_editorial.py -q -p no:cacheprovider`

Expected: FAIL with `TypeError: editorial_prompt() got an unexpected keyword argument 'evidence'`

- [ ] **Step 3: Give editorial_prompt an evidence form**

In `app/editorial/review.py`, change the signature to
`def editorial_prompt(locations, documents, instructions=None, evidence=None)` and, when `evidence` is a non-empty list, replace the `for index, text in enumerate(documents...)` block with:

```python
    if evidence:
        # The figures an editor has already checked, one line each, instead of
        # five whole reports. The reading step has done the finding; this call
        # only has to decide which site location each figure belongs to.
        parts += ["--- Prices read from the reports and checked by the editor ---"]

        for row in evidence:
            parts.append(json.dumps(row, sort_keys=True))

        parts.append("")
    else:
        for index, text in enumerate(documents, start=1):
            parts += [f"--- Report {index} ---", text, ""]
```

- [ ] **Step 4: Add the analyse route**

In `app/console/routes_editorial.py`, add `POST /console/sites/{slug}/editorial/analyse`. It does what the current draft handler does from "The site's current prices" onward, with three differences:

1. Instead of reading uploads, it loads `extractions.rows_for(set_id)` and keeps `row.kept`, turning each into the evidence dict (adding `filename`).
2. It passes `evidence=` to `editorial_prompt`, and passes the same rows' text to `price_digest` for the benchmark pass — build that text as one line per row, `f"{row.name} {row.price} {row.currency or ''}"`.
3. On success it calls `extractions.close_set(set_id)` so the reading is not offered again, and records `store.record(user.email, "used a reading", site.slug, f"reading #{set_id}")`.

The image-transcription block moves out of this handler entirely — it belongs to step 1 now. Delete it here.

`create_editorial_routes` gains an `extractions=None` keyword argument; when it is `None` the analyse route is not registered, so existing tests that build the router without it keep working.

- [ ] **Step 5: Point the upload form at step 1**

In `app/templates/editorial.html`, change the upload form's `action` to `/console/sites/{{ site.slug }}/reading` and its button to **Read the reports**, with `data-working-title="Reading the reports…"`. Leave the instructions box, the batch list and the results table exactly as they are.

- [ ] **Step 6: Delete the one-step draft handler**

The spec is explicit that the one-step path is not kept as an option: two screens doing the same job differently is what the owner already ruled against for price updates, and a dead POST route that still costs a full AI draft is worse than none.

Delete the `POST /console/sites/{slug}/editorial` handler in `app/console/routes_editorial.py` — the whole body from `uploads = [f for f in form_data.getlist("documents")...]` through its `return screen(...)`, including the image-transcription block, which now lives in `routes_reading.py`. Keep everything the analyse route shares: `screen()`, `guard()`, the GET form route, the instructions-saving branch, the stage/commit routes, and every import the analyse route still uses.

Then delete or rewrite any test that posts documents to `/console/sites/{slug}/editorial`. Search for it: `grep -rn "editorial\"" tests/ | grep -i post`. A test that pinned the old one-step behaviour is not a regression when it goes — but a test that pinned something the analyse route must still do (benchmarks merging, FX conversion, rules filling) must be moved to the analyse route, not deleted. Read each one before removing it.

**`POST /api/editorial-reviews` is a different route in a different file and must not be touched.**

- [ ] **Step 7: Run the tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker run --rm -v D:/project2026/petrosil-module-node:/src -w /src module-tests python -m pytest tests -q -p no:cacheprovider`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add app/editorial/review.py app/console/routes_editorial.py app/templates/editorial.html tests/test_editorial.py
git commit -m "feat: the analysis reads the checked figures, not five whole reports"
```

---

### Task 5: End to end against the real console

No new code unless this finds something. This is the task that proves the change on real data, the way the price-rule work was proved.

- [ ] **Step 1: Rebuild and confirm the migration**

```bash
cd /d/project2026/htdocs && docker compose up -d --build module
sleep 6 && docker logs petrosil-module --tail 20 | grep -i "migrat\|startup"
```

Expected: `applied 1 migration(s): 0009_reading_sets`, then `Application startup complete`.

- [ ] **Step 2: Make a throwaway console login**

```bash
docker exec petrosil-module python -m app.console.hash_password 'Check@12345'
docker exec petrosil-module-db psql -U module -d module -c "INSERT INTO console_users (email,name,password_hash,is_admin) VALUES ('check-reading@local.test','Check','<the hash>',true);"
```

- [ ] **Step 3: Read a real report through the real screen**

```bash
D=<scratchpad>
curl -s -c $D/cj.txt -o /dev/null -X POST http://localhost:8096/console/login \
  -d "email=check-reading@local.test&password=Check@12345"
curl -s -b $D/cj.txt -F "documents=@'D:/Downloads/Sample Market Report (Demo).xlsx'" \
  http://localhost:8096/console/sites/baseoil/reading -o $D/reading.html -w "%{http_code}\n"
```

Expected: a 303 to `/console/sites/baseoil/reading/<id>`, and that page lists the file with the prices it printed, names as written in the report.

- [ ] **Step 4: Check the two numbers that matter**

```bash
docker exec petrosil-module-db psql -U module -d module -c \
  "SELECT filename, count(*) FROM console_reading_rows GROUP BY filename;"
docker exec petrosil-module-db psql -U module -d module -c \
  "SELECT kind, count(*), sum(prompt_tokens) FROM console_ai_usage WHERE created_at > now() - interval '10 minutes' GROUP BY kind;"
```

Record both in the commit message: how many prices each report yielded, and the prompt tokens per call versus the old single call. The claim this change rests on is that the per-file prompts are far smaller than the 65k-character combined one.

- [ ] **Step 5: Run the analysis and compare against the old behaviour**

Post the reading to `/console/sites/baseoil/editorial/analyse` and count the rows that come back `suggested` rather than `no_evidence`. The measured baseline to beat with gpt-4o-mini on the 19.08 Lube Report is **0 direct suggestions out of 47**.

- [ ] **Step 6: Clean up**

```bash
docker exec petrosil-module-db psql -U module -d module -c "DELETE FROM console_users WHERE email='check-reading@local.test';"
docker exec petrosil-module-db psql -U module -d module -c "DELETE FROM console_reading_sets WHERE created_by='check-reading@local.test';"
```

- [ ] **Step 7: Commit the findings**

```bash
git commit --allow-empty -F -   # the measurements, in the message
```

---

## Notes for whoever executes this

- **`POST /api/editorial-reviews` (the headless twin) is not changed.** It still takes documents and drafts in one call. Task 4's `evidence=None` default is what keeps it working; do not remove that default.
- **Do not delete the one-step draft handler until Task 4 is green.** It is what the whole editorial screen currently runs on.
- **There is no native Python on this machine.** Every test run goes through the `module-tests` image; rebuild it from `python:3.12-slim` + `requirements.txt` + `pytest httpx` if it is missing.
- **Deploying to production** is `railway up --service petrosil-standaloneModule`, run by the owner — the permission classifier blocks it here. Migration `0009` applies itself at boot on Railway, the same as locally.
