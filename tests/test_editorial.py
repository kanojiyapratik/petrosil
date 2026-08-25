"""The editorial review: market reports in, a reviewed price draft out.

Modelled on the sample sheet the owner supplied: per location, a suggested
range with confidence, basis, source and rationale. The model proposes; the
code validates every row and computes every number the editor acts on.
"""

import io
import json
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.gemini import AiCompletion, AiProviderError
from app.api import create_api
from app.editorial.extract import document_to_text
from app.editorial.review import build_rows, editorial_prompt, parse_suggestions

TOKEN = "test-api-token"

WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def build_docx(paragraphs: list[str]) -> bytes:
    """A minimal, valid docx: a zip holding word/document.xml."""
    body = "".join(
        f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs
    )
    document = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{WORD_NS}"><w:body>{body}</w:body></w:document>'
    )
    buffer = io.BytesIO()

    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document)

    return buffer.getvalue()


SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def build_xlsx(rows: list[list[str]]) -> bytes:
    """A minimal, valid xlsx: worksheet cells referencing shared strings."""
    strings: list[str] = []
    body = ""

    for row_at, row in enumerate(rows, start=1):
        cells = ""

        for col_at, value in enumerate(row):
            strings.append(value)
            ref = f"{chr(65 + col_at)}{row_at}"
            cells += f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>'

        body += f'<row r="{row_at}">{cells}</row>'

    shared = "".join(f"<si><t>{s}</t></si>" for s in strings)
    buffer = io.BytesIO()

    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "xl/sharedStrings.xml",
            f'<sst xmlns="{SHEET_NS}" count="{len(strings)}">{shared}</sst>',
        )
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            f'<worksheet xmlns="{SHEET_NS}"><sheetData>{body}</sheetData></worksheet>',
        )

    return buffer.getvalue()


class TestDocumentToText:
    def test_reads_the_paragraphs_out_of_a_docx(self):
        docx = build_docx(["Weekly Asia Base Oil Price Report", "SN150 fell by $60/t"])

        text = document_to_text("Lube Report (14.08.2026).docx", docx)

        assert "Weekly Asia Base Oil Price Report" in text
        assert "SN150 fell by $60/t" in text
        # Paragraphs stay separate lines, or prices merge into their headings.
        assert text.index("Report") < text.index("SN150")
        assert "\n" in text

    def test_reads_plain_text(self):
        assert document_to_text("notes.txt", "SN500 at $1,500/t".encode()) == "SN500 at $1,500/t"

    def test_reads_a_pdf_through_the_crawlers_reader(self):
        from tests.test_pdf import build_pdf

        text = document_to_text("report.pdf", build_pdf(["Singapore 845.00"]))

        assert "845.00" in text

    def test_reads_the_cells_out_of_an_xlsx(self):
        # Market data often arrives as a spreadsheet -- the owner's own sample
        # was one. Shared strings are how Excel actually stores text.
        xlsx = build_xlsx(
            [
                ["Location", "Assessment"],
                ["Singapore SN 150 FOB Group I", "USD 1,540-1,580/MT"],
            ]
        )

        text = document_to_text("Sample Market Report.xlsx", xlsx)

        assert "Singapore SN 150 FOB Group I" in text
        assert "1,540-1,580" in text
        # Cells of one row stay on one line, rows stay apart.
        assert text.index("Assessment") < text.index("Singapore")

    def test_a_broken_or_unknown_file_returns_nothing_rather_than_raising(self):
        assert document_to_text("report.docx", b"not a zip") == ""
        assert document_to_text("report.xlsx", b"not a zip") == ""
        assert document_to_text("report.exe", b"whatever") == ""
        assert document_to_text("report", b"") == ""


LOCATIONS = ["Singapore SN 150 FOB Group I", "UAE 4 CST FOB Group III"]


class TestEditorialPrompt:
    def test_carries_the_locations_and_the_documents(self):
        prompt = editorial_prompt(LOCATIONS, ["Group III prices rose $100/t."])

        for location in LOCATIONS:
            assert location in prompt

        assert "Group III prices rose $100/t." in prompt

    def test_demands_json_and_forbids_invented_locations(self):
        prompt = editorial_prompt(LOCATIONS, ["text"])

        assert "JSON" in prompt
        assert "exactly" in prompt.lower()

    def test_asks_for_unlisted_evidence_under_the_reports_own_name(self):
        # This is what feeds the "close to X — is this correct?" rows.
        prompt = editorial_prompt(LOCATIONS, ["text"])

        assert "as printed" in prompt.lower()


def suggestion(location, low=1500, high=1600, confidence="High", **extra):
    row = {
        "location": location,
        "suggested_min": low,
        "suggested_max": high,
        "confidence": confidence,
        "basis": "FOB Asia, 10-Aug-2026",
        "source": "Lube Report 14-Aug-2026",
        "rationale": "Latest FOB Asia assessment.",
    }
    row.update(extra)

    return row


class TestParseSuggestions:
    def test_reads_a_fenced_json_array(self):
        text = "```json\n" + json.dumps([suggestion(LOCATIONS[0])]) + "\n```"

        parsed = parse_suggestions(text, LOCATIONS)

        assert parsed.suggestions[LOCATIONS[0]]["suggested_min"] == 1500
        assert parsed.unmatched == []

    def test_an_unlisted_location_is_kept_for_near_matching_not_lost(self):
        text = json.dumps([suggestion("Atlantis SN 150")])

        parsed = parse_suggestions(text, LOCATIONS)

        assert parsed.suggestions == {}
        assert [row["location"] for row in parsed.unmatched] == ["Atlantis SN 150"]

    def test_a_body_that_is_not_json_is_an_empty_result(self):
        parsed = parse_suggestions("The market rose broadly.", LOCATIONS)

        assert parsed.suggestions == {}


class TestBuildRows:
    def build(self, model_rows, current=None):
        parsed = parse_suggestions(json.dumps(model_rows), LOCATIONS)

        return build_rows(
            LOCATIONS,
            {LOCATIONS[0]: 1485, LOCATIONS[1]: 1925} if current is None else current,
            parsed,
        )

    def test_computes_midpoint_and_change_in_code(self):
        rows = self.build([suggestion(LOCATIONS[0], low=1500, high=1600)])
        row = next(r for r in rows if r["location"] == LOCATIONS[0])

        assert row["status"] == "suggested"
        assert row["suggested_price"] == 1550
        assert row["current_price"] == 1485
        assert row["change_pct"] == 4.38  # (1550-1485)/1485, half away from zero
        assert row["confidence"] == "high"
        assert row["flag"] is None

    def test_a_location_with_no_row_from_the_model_is_no_evidence(self):
        rows = self.build([suggestion(LOCATIONS[0])])
        row = next(r for r in rows if r["location"] == LOCATIONS[1])

        assert row["status"] == "no_evidence"
        assert row["suggested_price"] is None
        assert row["current_price"] == 1925

    def test_unusable_numbers_make_the_row_invalid_not_a_crash(self):
        rows = self.build([suggestion(LOCATIONS[0], low="soon", high=None)])

        assert next(r for r in rows if r["location"] == LOCATIONS[0])["status"] == "invalid"

    def test_a_swapped_range_is_normalised(self):
        rows = self.build([suggestion(LOCATIONS[0], low=1600, high=1500)])
        row = next(r for r in rows if r["location"] == LOCATIONS[0])

        assert (row["suggested_min"], row["suggested_max"]) == (1500, 1600)

    def test_a_wild_jump_is_flagged_for_the_editor(self):
        # Same floor as suspected_errors: a >=50% move needs a human eye.
        rows = self.build([suggestion(LOCATIONS[0], low=2900, high=3000)])

        assert next(r for r in rows if r["location"] == LOCATIONS[0])["flag"] == "check"

    def test_an_unknown_confidence_reads_as_low(self):
        rows = self.build([suggestion(LOCATIONS[0], confidence="certain")])

        assert next(r for r in rows if r["location"] == LOCATIONS[0])["confidence"] == "low"

    def test_a_close_name_becomes_a_near_match_asking_for_confirmation(self):
        # The report writes the grade its own way; the editor is asked "close
        # to this tracked location — is this correct?" rather than losing it.
        rows = self.build([suggestion("Singapore Group I SN 150", low=1540, high=1580)])
        row = next(r for r in rows if r["location"] == "Singapore SN 150 FOB Group I")

        assert row["status"] == "near_match"
        assert row["reported_as"] == "Singapore Group I SN 150"
        assert row["suggested_price"] == 1560
        assert row["current_price"] == 1485

    def test_word_order_and_spelling_of_the_report_do_not_matter_much(self):
        rows = self.build([suggestion("UAE 4cst Group 3", low=2910, high=2950)])
        row = next(r for r in rows if r["location"] == "UAE 4 CST FOB Group III")

        assert row["status"] == "near_match"
        assert row["reported_as"] == "UAE 4cst Group 3"

    def test_an_exact_suggestion_beats_a_near_match_for_the_same_location(self):
        rows = self.build(
            [
                suggestion(LOCATIONS[0], low=1500, high=1600),
                suggestion("Singapore Group I SN 150", low=9000, high=9100),
            ]
        )
        row = next(r for r in rows if r["location"] == LOCATIONS[0])

        assert row["status"] == "suggested"
        assert row["suggested_price"] == 1550

    def test_something_totally_unrelated_is_still_dropped(self):
        rows = self.build([suggestion("Brent Crude Futures September")])

        assert all(row["status"] in ("no_evidence",) for row in rows)

    def test_a_location_without_a_current_price_still_gets_a_suggestion(self):
        rows = build_rows(
            LOCATIONS,
            {},
            parse_suggestions(json.dumps([suggestion(LOCATIONS[0])]), LOCATIONS),
        )
        row = next(r for r in rows if r["location"] == LOCATIONS[0])

        assert row["current_price"] is None
        assert row["change_pct"] is None
        assert row["status"] == "suggested"


MODEL_ANSWER = json.dumps(
    [
        suggestion("Singapore SN 150 FOB Group I", low=1540, high=1580),
        suggestion("Atlantis SN 150"),
    ]
)


class StubDriver:
    def __init__(self, completion=None, raises=None):
        self._completion = completion or AiCompletion(
            status="complete",
            text=MODEL_ANSWER,
            prompt_tokens=900,
            completion_tokens=200,
            error=None,
        )
        self._raises = raises
        self.calls = []

    def generate(self, model, prompt):
        self.calls.append({"model": model, "prompt": prompt})

        if self._raises:
            raise self._raises

        return self._completion


def client_for(driver=None, record_use=None):
    app = FastAPI()
    app.include_router(
        create_api(
            api_token=TOKEN,
            driver=driver or StubDriver(),
            default_model="gemini-2.5-flash",
            record_use=record_use,
        )
    )

    return TestClient(app)


def post(client, payload=None, token=TOKEN, documents=None):
    headers = {"authorization": f"Bearer {token}"} if token else {}
    body = payload if payload is not None else {
        "price_date": "2099-08-24",
        "current_prices": [
            {"location": "Singapore SN 150 FOB Group I", "price": 1575},
            {"location": "UAE 4 CST FOB Group III", "price": 1925},
        ],
    }
    files = documents if documents is not None else [
        ("documents", ("report.docx", build_docx(["FOB Asia SN150 $1,540-1,580/t"]),
                       "application/vnd.openxmlformats-officedocument.wordprocessingml.document")),
    ]

    return client.post(
        "/api/editorial-reviews",
        data={"payload": json.dumps(body)},
        files=files,
        headers=headers,
    )


class TestEditorialReviewsEndpoint:
    def test_needs_a_token(self):
        assert post(client_for(), token=None).status_code == 401

    def test_rejects_a_payload_missing_its_parts(self):
        assert post(client_for(), payload={"price_date": "2099-08-24"}).status_code == 422
        assert post(
            client_for(), payload={"current_prices": [{"location": "X", "price": 1}]}
        ).status_code == 422

    def test_rejects_a_request_with_no_readable_document(self):
        response = post(
            client_for(),
            documents=[("documents", ("report.docx", b"not a zip", "application/zip"))],
        )

        assert response.status_code == 422

    def test_returns_rows_summary_and_metadata(self):
        driver = StubDriver()
        response = post(client_for(driver))

        assert response.status_code == 201
        body = response.json()

        singapore = next(
            r for r in body["rows"] if r["location"] == "Singapore SN 150 FOB Group I"
        )
        assert singapore["status"] == "suggested"
        assert singapore["suggested_price"] == 1560
        assert singapore["current_price"] == 1575

        uae = next(r for r in body["rows"] if r["location"] == "UAE 4 CST FOB Group III")
        assert uae["status"] == "no_evidence"

        assert body["summary"]["suggested"] == 1
        assert body["summary"]["no_evidence"] == 1
        assert body["summary"]["near_match"] == 0
        assert body["summary"]["dropped_unknown"] == 1
        assert body["analysis"]["status"] == "complete"
        assert body["analysis"]["model"] == "gemini-2.5-flash"

        # The prompt carried the document text and the locations.
        prompt = driver.calls[0]["prompt"]
        assert "FOB Asia SN150" in prompt
        assert "UAE 4 CST FOB Group III" in prompt

    def test_a_model_decline_is_a_201_with_no_rows_suggested(self):
        driver = StubDriver(
            AiCompletion(
                status="declined", text=None, prompt_tokens=None,
                completion_tokens=None, error="The model declined to respond: SAFETY",
            )
        )
        body = post(client_for(driver)).json()

        assert body["analysis"]["status"] == "declined"
        assert body["summary"]["suggested"] == 0

    def test_a_draft_records_its_usage(self):
        used = []
        post(client_for(record_use=lambda **kw: used.append(kw)))

        assert len(used) == 1
        assert used[0]["kind"] == "editorial"
        assert used[0]["status"] == "complete"
        assert used[0]["prompt_tokens"] == 900

    def test_a_provider_failure_is_a_502(self):
        driver = StubDriver(raises=AiProviderError("Gemini could not be reached"))
        response = post(client_for(driver))

        assert response.status_code == 502
        assert response.json()["analysis"]["status"] == "failed"
