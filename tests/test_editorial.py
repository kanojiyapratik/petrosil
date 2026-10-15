"""The editorial review: market reports in, a reviewed price draft out.

Modelled on the sample sheet the owner supplied: per location, a suggested
range with confidence, basis, source and rationale. The model proposes; the
code validates every row and computes every number the editor acts on.
"""

import dataclasses
import io
import json
import re
import zipfile
from datetime import datetime

from fastapi import FastAPI
from fastapi.templating import Jinja2Templates
from fastapi.testclient import TestClient

from app.ai.gemini import AiCompletion, AiProviderError
from app.api import create_api
from app.console.routes_editorial import (
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENTS,
    create_editorial_routes,
)
from app.db.store import ReadingSet, ReadRow, StoredSite
from app.editorial.extract import document_to_text
from app.editorial.review import build_rows, editorial_prompt, parse_suggestions
from app.editorial.rules import PriceRule

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


class TestDocumentImages:
    """The USA posted prices are a PNG embedded in the report -- the client
    flagged them as not picked up. The pictures come out here; a vision model
    transcribes them."""

    def test_the_embedded_pictures_come_out_of_a_docx(self):
        from app.editorial.extract import document_images

        docx = build_docx(["some text"])
        # Rebuild with an embedded image alongside the document body.
        buffer = io.BytesIO()

        with zipfile.ZipFile(io.BytesIO(docx)) as source, zipfile.ZipFile(buffer, "w") as out:
            for name in source.namelist():
                out.writestr(name, source.read(name))

            out.writestr("word/media/image1.png", b"\x89PNG fake image bytes")

        images = document_images("report.docx", buffer.getvalue())

        assert images == [("image/png", b"\x89PNG fake image bytes")]

    def test_files_without_pictures_yield_nothing(self):
        from app.editorial.extract import document_images

        assert document_images("report.docx", build_docx(["text"])) == []
        assert document_images("report.txt", b"plain text") == []
        assert document_images("report.docx", b"not a zip") == []


class TestDocumentImagesForPdf:
    """The HPCL circular the owner uploaded is a scan -- a page-sized JPEG
    with no text layer at all. document_to_text correctly returns "" for it,
    so the picture has to come out here for a vision model to read the
    prices out of it."""

    def test_a_pdf_with_real_text_harvests_no_pictures(self):
        from app.editorial.extract import PDF_TEXT_FLOOR, document_images

        # Real text well past the floor, alongside a picture big enough to
        # clear the size floor too -- the BPCL circular's own situation: good
        # text and a couple of logos that are not worth a vision call.
        lines = ["Singapore SN 150 FOB Group I 845.00"] * 10
        assert sum(len(line) for line in lines) >= PDF_TEXT_FLOOR

        pdf = build_pdf_with_images(lines, [("/DCTDecode", _jpeg_bytes(40_000))])

        assert document_images("report.pdf", pdf) == []

    def test_a_text_free_pdf_with_a_big_picture_harvests_it(self):
        from app.editorial.extract import document_images

        jpeg = _jpeg_bytes(40_000)
        pdf = build_pdf_with_images([], [("/DCTDecode", jpeg)])

        assert document_images("report.pdf", pdf) == [("image/jpeg", jpeg)]

    def test_a_picture_under_the_size_floor_is_skipped(self):
        from app.editorial.extract import document_images

        pdf = build_pdf_with_images([], [("/DCTDecode", _jpeg_bytes(500))])

        assert document_images("report.pdf", pdf) == []

    def test_the_image_cap_holds_across_a_multi_page_scan(self):
        from app.editorial.extract import MAX_IMAGES, document_images

        images = [("/DCTDecode", _jpeg_bytes(21_000)) for _ in range(MAX_IMAGES + 3)]
        pdf = build_pdf_with_images([], images)

        assert len(document_images("report.pdf", pdf)) == MAX_IMAGES

    def test_a_corrupt_picture_is_skipped_rather_than_raising(self):
        from app.editorial.extract import document_images

        good = _jpeg_bytes(30_000)
        # None stands for an /Image XObject with no stream at all -- what a
        # corrupted or unusually encoded picture looks like to code that
        # expects every image object to carry picture bytes.
        pdf = build_pdf_with_images([], [(None, b""), ("/DCTDecode", good)])

        assert document_images("report.pdf", pdf) == [("image/jpeg", good)]

    def test_a_broken_pdf_yields_no_pictures_rather_than_raising(self):
        from app.editorial.extract import document_images

        assert document_images("report.pdf", b"not a pdf") == []
        assert document_images("report.pdf", b"") == []


def build_pdf_with_images(lines: list[str], images: list[tuple[str | None, bytes]]) -> bytes:
    """A minimal, valid single-page PDF (built the same way as
    tests/test_pdf.py's build_pdf) whose page /Resources also lists one
    XObject per entry in `images`.

    Each entry is (filter_name, data). filter_name is a PDF /Filter name
    such as "/DCTDecode", or None for an /Image XObject with no stream at
    all -- the shape of the corrupted or unusual image pypdf's own image
    extraction is documented to throw on. Nothing here draws the pictures
    into the content stream: document_images reads the Resources dictionary
    directly, so an entry only needs to be listed there.
    """
    content = "BT /F1 12 Tf 40 720 Td 14 TL\n"
    content += "".join(f"({line}) Tj T*\n" for line in lines)
    content += "ET"
    stream = content.encode("latin-1")

    xobject_entries = []
    image_objects = []

    for at, (filt, data) in enumerate(images, start=1):
        obj_num = 5 + at
        xobject_entries.append(f"/Im{at} {obj_num} 0 R")

        if filt is None:
            image_objects.append(
                b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
                b"/Filter /DCTDecode >>"
            )
        else:
            image_objects.append(
                (
                    f"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
                    f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter {filt} "
                    f"/Length {len(data)} >>\nstream\n"
                ).encode("latin-1")
                + data
                + b"\nendstream"
            )

    resources = (
        b"<< /Font << /F1 5 0 R >> /XObject << "
        + " ".join(xobject_entries).encode("latin-1")
        + b" >> >>"
    )

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources " + resources + b" /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        *image_objects,
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []

    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"

    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()

    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF"
    ).encode()

    return bytes(out)


# A stand-in for a JPEG: real content does not matter because DCTDecode bytes
# pass straight through to the vision model unmodified, but the SOI/EOI
# markers keep it recognisably JPEG-shaped.
def _jpeg_bytes(size: int) -> bytes:
    body = b"\xff\xd8\xff\xe0" + (b"\x00" * (size - 8)) + b"\xff\xd9"
    return body


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

    def test_forbids_decorating_a_copied_name_with_added_words(self):
        # A model that answers "Report - Table: X" for asked name "Report: X"
        # is matched literally downstream; the prompt must say plainly not to
        # add words like "Table" or "Image" around a name it copies.
        prompt = editorial_prompt(LOCATIONS, ["text"])

        assert "nothing added" in prompt.lower()
        assert '"Table"' in prompt
        assert '"Image"' in prompt

    def test_asks_for_unlisted_evidence_under_the_reports_own_name(self):
        # This is what feeds the "close to X — is this correct?" rows.
        prompt = editorial_prompt(LOCATIONS, ["text"])

        assert "as printed" in prompt.lower()

    def test_carries_the_editors_instructions_when_given(self):
        # The editor knows things about their reports the prompt cannot ("the
        # USA prices sit in the picture table") -- a free-text field carries
        # that knowledge into the model.
        prompt = editorial_prompt(
            LOCATIONS, ["text"], instructions="The USA prices are inside the picture table."
        )

        assert "The USA prices are inside the picture table." in prompt
        assert "Editor's instructions" in prompt
        # Guidance only: they must not be able to loosen the output contract.
        assert "cannot change" in prompt

    def test_without_instructions_there_is_no_instructions_section(self):
        assert "Editor's instructions" not in editorial_prompt(LOCATIONS, ["text"])
        assert "Editor's instructions" not in editorial_prompt(LOCATIONS, ["text"], instructions="   ")

    def test_two_rows_sharing_a_name_are_told_to_be_one_item_not_two(self):
        # Measured on a real upload: a BPCL circular printed BASIC and TOTAL
        # for every product, and every product came out doubled because
        # nothing said the two rows were the same item on different terms.
        prompt = editorial_prompt(LOCATIONS, ["text"])

        assert "never two locations" in prompt
        assert "pre-tax / basic figure" in prompt
        assert "rationale" in prompt

    def test_the_editors_instructions_and_the_tie_break_wording_are_in_the_same_prompt(self):
        # The default is a ruling, not an absolute -- an editor's own per-site
        # instructions must be able to override it, so both have to reach the
        # model in the one prompt, not one instead of the other.
        prompt = editorial_prompt(
            LOCATIONS, ["text"],
            instructions="For this site, use the TOTAL (tax-inclusive) figure instead.",
        )

        assert "For this site, use the TOTAL (tax-inclusive) figure instead." in prompt
        assert "pre-tax / basic figure" in prompt
        assert "unless the editor's own instructions say otherwise" in prompt


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

    def test_boilerplate_wrapped_around_a_benchmark_name_is_reclaimed_as_suggested(self):
        # Measured on the client's real data: the model answered "Report -
        # Table: ..." for an asked name of "Report: ..." -- same figure, same
        # report line, but the added "- Table" made parse_suggestions file it
        # under unmatched. It must land as `suggested`, not `near_match`, so
        # a rule can derive from it.
        asked = LOCATIONS + ["Report: Group I 70 Holly Frontier Midwest $/MT"]
        parsed = parse_suggestions(
            json.dumps(
                [
                    suggestion(
                        "Report - Table: Group I 70 Holly Frontier Midwest $/MT",
                        low=3050, high=3100,
                    )
                ]
            ),
            asked,
        )
        rows = build_rows(asked, {}, parsed)
        row = next(
            r for r in rows
            if r["location"] == "Report: Group I 70 Holly Frontier Midwest $/MT"
        )

        assert row["status"] == "suggested"
        assert row["reported_as"] is None
        assert row["suggested_price"] == 3075

    def test_a_genuinely_different_grade_does_not_reclaim(self):
        asked = LOCATIONS + ["Report: Group I 150"]
        parsed = parse_suggestions(
            json.dumps([suggestion("Report: Group I 500", low=1000, high=1000)]), asked,
        )
        rows = build_rows(asked, {}, parsed)
        row = next(r for r in rows if r["location"] == "Report: Group I 150")

        assert row["status"] == "no_evidence"

    def test_an_ambiguous_normalised_form_reclaims_neither_asked_name(self):
        # Two asked names that collapse to the same normalised form once
        # filler is stripped -- reclaiming either would be a guess.
        asked = LOCATIONS + [
            "Report: Group I 150",
            "Report - Table: Group I 150",
        ]
        parsed = parse_suggestions(
            json.dumps([suggestion("Report - Image: Group I 150", low=1000, high=1000)]),
            asked,
        )
        rows = build_rows(asked, {}, parsed)

        assert next(r for r in rows if r["location"] == "Report: Group I 150")["status"] in (
            "no_evidence", "near_match",
        )
        assert next(
            r for r in rows if r["location"] == "Report - Table: Group I 150"
        )["status"] in ("no_evidence", "near_match")
        assert not any(
            r["status"] == "suggested"
            for r in rows
            if r["location"] in ("Report: Group I 150", "Report - Table: Group I 150")
        )

    def test_a_real_near_match_still_needs_confirmation_not_reclaimed(self):
        # Word order and spelling differ, unlike the boilerplate case above --
        # this must still land as near_match.
        rows = self.build([suggestion("Singapore Group I SN 150", low=1540, high=1580)])
        row = next(r for r in rows if r["location"] == "Singapore SN 150 FOB Group I")

        assert row["status"] == "near_match"

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

    def test_the_checked_notes_reach_the_evidence_json(self):
        # Two rows sharing a name, one BASIC and one TOTAL, are indistinguishable
        # to step two unless the qualifier travels with them.
        prompt = editorial_prompt(
            ["Singapore SN 150 FOB Group I"], [], None,
            evidence=[
                {
                    "name": "Bit Bulk VG10", "price": 69100.0, "price_min": None,
                    "price_max": None, "currency": "INR", "unit": "MT",
                    "basis": "Ex Mumbai Refinery", "price_date": "2026-09-01",
                    "note": "BASIC", "filename": "bpcl.pdf",
                },
                {
                    "name": "Bit Bulk VG10", "price": 81538.0, "price_min": None,
                    "price_max": None, "currency": "INR", "unit": "MT",
                    "basis": "Ex Mumbai Refinery", "price_date": "2026-09-01",
                    "note": "TOTAL incl. GST", "filename": "bpcl.pdf",
                },
            ],
        )

        assert '"note": "BASIC"' in prompt
        assert '"note": "TOTAL incl. GST"' in prompt

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


SITE = StoredSite(
    db_id=1, slug="baseoil", name="Base Oil Report",
    api_url="https://example.test/api", token="t", enabled=True,
    editorial_instructions="Ignore last week's recap.",
)


class AnalyseFakeStore:
    def __init__(self, site=SITE):
        self.site = site
        self.recorded = []

    def site_by_slug(self, slug):
        return self.site if slug == self.site.slug else None

    def record(self, *args, **kwargs):
        self.recorded.append(args)

    def set_editorial_instructions(self, slug, text):
        self.site = dataclasses.replace(self.site, editorial_instructions=text.strip() or None)


class AnalyseFakeSiteClient:
    def __init__(self, locations):
        self._locations = locations

    def locations(self):
        return {"data": self._locations}

    def batches(self):
        return {"data": []}

    def stage_rows(self, rows, price_date=None, source=None):
        self.staged = rows

        return {"batch": {"id": 31}}


class AnalyseFakeRules:
    def __init__(self, rules):
        self._rules = rules

    def for_site(self, slug):
        return self._rules


class AnalyseFakeExtractions:
    """Honours `set_id` on both `rows_for` and `set_by_id` -- the spec's own
    fake for the reading routes (`FakeExtractions` in test_reading_routes.py)
    ignored it, which is exactly how a missing site/set guard on `analyse`
    could pass a green suite unnoticed."""

    def __init__(self, rows, set_id=7, site_slug="baseoil", used_at=None):
        self._rows = {set_id: rows}
        self._sets = {
            set_id: ReadingSet(
                id=set_id, site_slug=site_slug, created_by="editor@local.test",
                created_at=None, files=[], used_at=used_at,
            )
        }
        self.closed = []
        self.reclaimed = []
        self.released = []

    def set_by_id(self, set_id):
        return self._sets.get(set_id)

    def rows_for(self, set_id):
        return self._rows.get(set_id, [])

    def latest_open(self, site_slug):
        return next(
            (
                entry for entry in self._sets.values()
                if entry.site_slug == site_slug and entry.used_at is None
            ),
            None,
        )

    def latest_used(self, site_slug):
        return next(
            (
                entry for entry in self._sets.values()
                if entry.site_slug == site_slug and entry.used_at is not None
            ),
            None,
        )

    def release_set(self, set_id):
        self.released.append(set_id)
        reading = self._sets.get(set_id)

        if reading is not None:
            self._sets[set_id] = dataclasses.replace(reading, used_at=None)

    def claim_set(self, set_id):
        """The real one is a single conditional UPDATE. This models exactly
        that: whoever finds used_at still empty takes it, and nobody else."""
        reading = self._sets.get(set_id)

        if reading is None or reading.used_at is not None:
            return False

        self._sets[set_id] = dataclasses.replace(reading, used_at="claimed")
        self.closed.append(set_id)

        return True

    def reclaim_set(self, set_id, used_at):
        """The real one is a compare-and-swap. This models exactly that: the
        caller has to be holding the used_at that is actually there."""
        reading = self._sets.get(set_id)

        if reading is None or str(reading.used_at or "") != str(used_at or ""):
            return False

        self._sets[set_id] = dataclasses.replace(
            reading, used_at=f"reclaimed-{len(self.reclaimed) + 1}"
        )
        self.reclaimed.append(set_id)

        return True


class RaisingReclaimExtractions(AnalyseFakeExtractions):
    """Stands in for the real ExtractionStore, whose reclaim_set casts the
    held value straight into ``... AND used_at = %s::timestamptz``. A bad
    cast raises inside Postgres -- exactly what the route must guard against
    before the value ever gets there. If the route calls reclaim_set at all
    with something unparseable, this raises the way the real database would."""

    def reclaim_set(self, set_id, used_at):
        try:
            datetime.fromisoformat(used_at)
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                f"invalid input syntax for type timestamp with time zone: {used_at!r}"
            ) from error

        return super().reclaim_set(set_id, used_at)


class AnalyseFakeRounding:
    def __init__(self, overrides):
        self._overrides = overrides

    def for_site(self, slug):
        return self._overrides


def build_analyse_client(
    rows, driver=None, rules_list=None, locations=None, store=None, fx=None,
    set_id=7, reading_site_slug="baseoil", used_at=None, rounding_overrides=None,
    drafts=None,
):
    from app.console.routes import datefmt, label_for

    extractions = AnalyseFakeExtractions(
        rows, set_id=set_id, site_slug=reading_site_slug, used_at=used_at
    )
    store = store or AnalyseFakeStore()
    templates = Jinja2Templates(directory="app/templates")
    templates.env.globals["datefmt"] = datefmt
    templates.env.globals["label_for"] = label_for
    app = FastAPI()
    app.include_router(
        create_editorial_routes(
            store=store,
            templates=templates,
            current_user=lambda request: type(
                "U", (), {"email": "editor@local.test", "name": "Editor", "is_admin": True, "is_superadmin": True}
            )(),
            driver=driver or StubDriver(),
            default_model="gemini-2.5-flash",
            client_factory=lambda site: AnalyseFakeSiteClient(
                locations if locations is not None
                else [{"title": "Europe Domestic SN150", "latest_price": 1000.0}]
            ),
            rules=AnalyseFakeRules(rules_list or []),
            extractions=extractions,
            fx=fx,
            rounding=AnalyseFakeRounding(rounding_overrides or {}),
            drafts=drafts,
        )
    )

    return TestClient(app), extractions, store


def kept_and_dropped_rows():
    return [
        ReadRow(
            id=1, set_id=7, filename="lube.docx", name="FOB Asia SN 150", price=1300.0,
            price_min=None, price_max=None, currency=None, unit="MT", basis="FOB",
            price_date="2026-08-14", note=None, kept=True,
        ),
        ReadRow(
            id=2, set_id=7, filename="lube.docx", name="Brent Crude Futures", price=80.0,
            price_min=None, price_max=None, currency=None, unit=None, basis=None,
            price_date=None, note=None, kept=False,
        ),
    ]


def empty_completion():
    return AiCompletion(status="complete", text="[]", prompt_tokens=1, completion_tokens=1, error=None)


class TestTheAnalyseRouteUsesTheCheckedRows:
    def test_only_kept_rows_reach_the_prompt(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(kept_and_dropped_rows(), driver=driver)

        client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        prompt = driver.calls[0]["prompt"]
        assert "FOB Asia SN 150" in prompt
        assert "1300" in prompt
        assert "lube.docx" in prompt
        # The dropped row never reaches the model.
        assert "Brent Crude Futures" not in prompt

    def test_the_editors_saved_instructions_ride_along(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(kept_and_dropped_rows(), driver=driver)

        client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert "Ignore last week's recap." in driver.calls[0]["prompt"]

    def test_nothing_kept_is_a_422_not_a_call_to_the_model(self):
        driver = StubDriver(empty_completion())
        dropped_only = [row for row in kept_and_dropped_rows() if not row.kept]
        client, extractions, store = build_analyse_client(dropped_only, driver=driver)

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 422
        assert "Nothing was kept" in response.text
        assert driver.calls == []

    def test_a_set_id_that_is_not_a_number_is_a_404(self):
        client, extractions, store = build_analyse_client(kept_and_dropped_rows())

        response = client.post(
            "/console/sites/baseoil/editorial/analyse", data={"set_id": "not-a-number"}
        )

        assert response.status_code == 404

    def test_success_closes_the_reading_and_is_recorded(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(kept_and_dropped_rows(), driver=driver)

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 200
        assert extractions.closed == [7]
        assert store.recorded[-1] == (
            "editor@local.test", "used a reading", "baseoil", "reading #7",
        )

    def test_the_focused_benchmark_pass_reads_the_checked_rows_not_report_text(self):
        # The point of Task 4: the second, focused reading no longer needs
        # price_digest() to scan whole reports -- it scans the checked rows.
        rule = PriceRule(
            id=1, derived_location="Europe Domestic SN150",
            reference_location="Report: FOB Asia SN 150", adjustment_value=-20,
        )
        answer = json.dumps(
            [
                {
                    "location": "Report: FOB Asia SN 150", "suggested_min": 1280,
                    "suggested_max": 1320, "confidence": "high", "basis": "FOB Asia",
                    "source": "reading", "rationale": "checked by the editor",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="FOB Asia SN 150", price=1300.0,
                price_min=None, price_max=None, currency="USD", unit="MT", basis="FOB",
                price_date="2026-08-14", note=None, kept=True,
            ),
        ]
        client, extractions, store = build_analyse_client(rows, driver=driver, rules_list=[rule])

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 200
        # Two model calls: the main pass and the focused benchmark pass.
        assert len(driver.calls) == 2
        focused_prompt = driver.calls[1]["prompt"]
        assert "FOB Asia SN 150" in focused_prompt
        assert "1300" in focused_prompt
        # The rulebook -- code, not the model -- derives the site location
        # from the benchmark the focused pass confirmed.
        assert "Europe Domestic SN150" in response.text

    def test_a_provider_failure_is_a_502_not_a_500(self):
        driver = StubDriver(raises=AiProviderError("Gemini could not be reached"))
        client, extractions, store = build_analyse_client(kept_and_dropped_rows(), driver=driver)

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 502
        # The reading was claimed before the call -- that is the whole point of
        # claiming before spending money -- so it is spent. Getting back to it
        # is the deliberate "Use these prices again" button, not a re-upload.
        assert extractions.closed == [7]


class RecordingFx:
    """Records what it was asked to convert -- proves the analyse route
    passed the picked pricedate through, not today's date."""

    def __init__(self):
        self.calls = []

    def get(self, currency, on_date):
        self.calls.append((currency, on_date))

        return None


class FakeFxAtFixedRate:
    """A rate always available, for tests that only care what comes out the
    other side of the conversion, not which date it was asked for."""

    def __init__(self, rate):
        self._rate = rate

    def get(self, currency, on_date):
        from app.editorial.fx import FxRate

        return FxRate(currency=currency, rate=self._rate, rate_date=on_date, source="ECB")


class TestTheChosenPriceDateReachesFxConversion:
    def test_a_posted_pricedate_is_used_for_fx_not_todays_date(self):
        # The row's own price_date is null, so convert_rows falls back to the
        # analysis's pricedate -- exactly the value that must come from the
        # form, not from date.today().
        answer = json.dumps(
            [
                {
                    "location": "Europe Domestic SN150", "suggested_min": 80000,
                    "suggested_max": 82000, "confidence": "high", "basis": "Ex-rack Izmir",
                    "source": "reading", "rationale": "checked by the editor", "currency": "TRY",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="Europe Domestic SN150", price=81212.0,
                price_min=None, price_max=None, currency="TRY", unit="MT", basis="Ex-rack",
                price_date=None, note=None, kept=True,
            ),
        ]
        fx = RecordingFx()
        client, extractions, store = build_analyse_client(
            rows, driver=driver,
            locations=[{"title": "Europe Domestic SN150", "latest_price": 2500.0}],
            fx=fx,
        )

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "pricedate": "2026-08-12"},
        )

        assert response.status_code == 200
        assert fx.calls == [("TRY", "2026-08-12")]

    def test_without_a_posted_pricedate_it_falls_back_to_today(self):
        from datetime import date

        answer = json.dumps(
            [
                {
                    "location": "Europe Domestic SN150", "suggested_min": 80000,
                    "suggested_max": 82000, "confidence": "high", "basis": "Ex-rack Izmir",
                    "source": "reading", "rationale": "checked by the editor", "currency": "TRY",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="Europe Domestic SN150", price=81212.0,
                price_min=None, price_max=None, currency="TRY", unit="MT", basis="Ex-rack",
                price_date=None, note=None, kept=True,
            ),
        ]
        fx = RecordingFx()
        client, extractions, store = build_analyse_client(
            rows, driver=driver,
            locations=[{"title": "Europe Domestic SN150", "latest_price": 2500.0}],
            fx=fx,
        )

        client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert fx.calls == [("TRY", date.today().isoformat())]


class TestTheSitesOwnCurrencyReachesTheConversion:
    """The site's location list says which currency each location is priced
    in. A rupee circular for a rupee location must reach the editor as
    rupees -- the site stores the staged number in the location's currency,
    so converting it to dollars on the way would publish about $780 where
    the circular says Rs 69,100."""

    def test_a_rupee_figure_for_a_rupee_location_is_not_converted(self):
        answer = json.dumps(
            [
                {
                    "location": "BPCL BITUMEN - VG 10 (bulk)", "suggested_min": 69100,
                    "suggested_max": 69100, "confidence": "high",
                    "basis": "Ex Mumbai Refinery, basic rate", "source": "BPCL circular",
                    "rationale": "printed", "currency": "INR",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        rows = [
            ReadRow(
                id=1, set_id=7, filename="bpcl.pdf", name="Bit Bulk VG10", price=69100.0,
                price_min=None, price_max=None, currency="INR", unit="MT",
                basis="Ex Mumbai Refinery", price_date=None, note=None, kept=True,
            ),
        ]
        fx = RecordingFx()
        client, _, _ = build_analyse_client(
            rows, driver=driver,
            locations=[{
                "title": "BPCL BITUMEN - VG 10 (bulk)", "latest_price": None, "currency": "INR",
            }],
            fx=fx,
        )

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "pricedate": "2026-09-01"},
        )

        assert response.status_code == 200
        assert fx.calls == []
        assert 'value="69100' in response.text

    def test_a_site_that_names_no_currency_is_still_all_dollars(self):
        answer = json.dumps(
            [
                {
                    "location": "Europe Domestic SN150", "suggested_min": 80000,
                    "suggested_max": 82000, "confidence": "high", "basis": "Ex-rack Izmir",
                    "source": "reading", "rationale": "checked by the editor", "currency": "TRY",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="Europe Domestic SN150", price=81212.0,
                price_min=None, price_max=None, currency="TRY", unit="MT", basis="Ex-rack",
                price_date=None, note=None, kept=True,
            ),
        ]
        fx = RecordingFx()
        client, _, _ = build_analyse_client(
            rows, driver=driver,
            locations=[{"title": "Europe Domestic SN150", "latest_price": 2500.0}],
            fx=fx,
        )

        client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "pricedate": "2026-08-12"},
        )

        # Only the lira rate: a dollar destination needs no second rate.
        assert fx.calls == [("TRY", "2026-08-12")]


class TestTheAnalyseRouteRoundsThePrice:
    """The client's rulebook rounds nearly every price it derives from a
    report; the wiring lives in the analyse route, not just in the
    functions it calls -- see app/editorial/rounding.py."""

    def test_a_direct_suggestion_lands_rounded_and_still_editable(self):
        answer = json.dumps(
            [
                {
                    "location": "Europe Domestic SN150", "suggested_min": 1640,
                    "suggested_max": 1655, "confidence": "high", "basis": "Argus, page 12",
                    "source": "reading", "rationale": "checked by the editor",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        site = dataclasses.replace(SITE, round_to_nearest=5)
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, store=AnalyseFakeStore(site=site),
            locations=[{"title": "Europe Domestic SN150", "latest_price": 1000.0}],
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 200
        # Midpoint 1647.5 -> nearest 5 is 1650, and the price input still
        # carries it as the value an editor can type over.
        assert 'name="price_0"' in response.text
        assert 'value="1650"' in response.text
        assert "Rounded to the nearest 5" in response.text

    def test_a_location_override_beats_the_site_default(self):
        answer = json.dumps(
            [
                {
                    "location": "Europe Domestic SN150", "suggested_min": 1636,
                    "suggested_max": 1636, "confidence": "high", "basis": "Argus, page 6",
                    "source": "reading", "rationale": "checked by the editor",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        site = dataclasses.replace(SITE, round_to_nearest=5)
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, store=AnalyseFakeStore(site=site),
            locations=[{"title": "Europe Domestic SN150", "latest_price": 1000.0}],
            rounding_overrides={"Europe Domestic SN150": 10},
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        # 1636 rounds to 1635 on the site default, 1640 on the override --
        # the override must be what actually reaches the screen.
        assert 'value="1640"' in response.text
        assert "Rounded to the nearest 10" in response.text

    def test_an_fx_converted_price_lands_rounded_too(self):
        answer = json.dumps(
            [
                {
                    "location": "Europe Domestic SN150", "suggested_min": 81225,
                    "suggested_max": 81225, "confidence": "high", "basis": "ex-rack, excl VAT",
                    "source": "reading", "rationale": "checked by the editor", "currency": "TRY",
                    "price_date": "2026-08-19",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        site = dataclasses.replace(SITE, round_to_nearest=None)
        fx = FakeFxAtFixedRate(40.0)
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, store=AnalyseFakeStore(site=site),
            locations=[{"title": "Europe Domestic SN150", "latest_price": 2000.0}],
            fx=fx, rounding_overrides={"Europe Domestic SN150": 10},
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        # 81225 / 40 = 2030.625 -> rounded (2030.63) -> nearest 10 is 2030.
        assert 'value="2030"' in response.text
        assert "Rounded to the nearest 10" in response.text

    def test_a_rule_derived_price_lands_rounded_too(self):
        answer = json.dumps(
            [
                {
                    "location": "Singapore Bulk FOB", "suggested_min": 1643,
                    "suggested_max": 1643, "confidence": "high", "basis": "Argus, page 12",
                    "source": "reading", "rationale": "checked by the editor",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        site = dataclasses.replace(SITE, round_to_nearest=5)
        rule = PriceRule(
            id=1, derived_location="South Korea FOB", reference_location="Singapore Bulk FOB",
            adjustment_value=-10.0,
        )
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, store=AnalyseFakeStore(site=site),
            locations=[
                {"title": "Singapore Bulk FOB", "latest_price": 1600.0},
                {"title": "South Korea FOB", "latest_price": 1400.0},
            ],
            rules_list=[rule],
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        # 1643 * 0.9 = 1478.7 -> _whole gives 1479 -> nearest 5 is 1480.
        assert 'value="1480"' in response.text
        assert "Rounded to the nearest 5" in response.text
        # The derived price's own audit line survives alongside the new one.
        assert "Calculated from Singapore Bulk FOB" in response.text


class TestTheFocusedPassKeepsACurrencyLessCheckedRow:
    def test_a_row_with_no_currency_still_reaches_the_focused_pass(self):
        # price_digest() would drop this line -- its PRICE_LINE regex has
        # nothing to match without a currency token. The analyse route must
        # not run the evidence lines through it.
        rule = PriceRule(
            id=1, derived_location="Europe Domestic SN150",
            reference_location="Report: FOB Asia SN 150", adjustment_value=-20,
        )
        answer = json.dumps(
            [
                {
                    "location": "Report: FOB Asia SN 150", "suggested_min": 1280,
                    "suggested_max": 1320, "confidence": "high", "basis": "FOB Asia",
                    "source": "reading", "rationale": "checked by the editor",
                }
            ]
        )
        driver = StubDriver(
            AiCompletion(
                status="complete", text=answer, prompt_tokens=5, completion_tokens=5, error=None,
            )
        )
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="FOB Asia SN 150", price=1300.0,
                price_min=None, price_max=None, currency=None, unit="MT", basis="FOB",
                price_date="2026-08-14", note=None, kept=True,
            ),
        ]
        client, extractions, store = build_analyse_client(rows, driver=driver, rules_list=[rule])

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 200
        # Two model calls: the main pass and the focused benchmark pass --
        # the currency-less row still made it into the focused prompt.
        assert len(driver.calls) == 2
        focused_prompt = driver.calls[1]["prompt"]
        assert "FOB Asia SN 150" in focused_prompt
        assert "1300" in focused_prompt
        assert "Europe Domestic SN150" in response.text


class TestTheInstructionsBoxSavesOnItsOwn:
    def test_posting_instructions_saves_them_and_redirects_with_a_flash(self):
        client, extractions, store = build_analyse_client([])

        response = client.post(
            "/console/sites/baseoil/editorial",
            data={"instructions": "The USA prices are in the picture table."},
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"].startswith("/console/sites/baseoil/editorial?ok=")
        assert store.site.editorial_instructions == "The USA prices are in the picture table."

    def test_the_instructions_box_is_not_nested_inside_the_upload_form(self):
        # The upload form now posts to /reading -- if the instructions box
        # were still inside it, whatever the editor typed would travel there
        # and be silently discarded (routes_reading.py never reads it).
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text

        upload_form_at = page.index('action="/console/sites/baseoil/reading"')
        upload_form_closes_at = page.index("</form>", upload_form_at)
        instructions_at = page.index('name="instructions"')

        assert instructions_at > upload_form_closes_at
        # It has become its own form, posting back to the save-instructions route.
        assert 'action="/console/sites/baseoil/editorial"' in page


class TestTheAnalyseRouteGuardsTheReadingsOwnership:
    """routes_reading.py's `check` and `edit_row` both refuse a set that does
    not belong to this site; `analyse` had no such guard at all."""

    def test_a_reading_belonging_to_another_site_is_a_404_not_analysed(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, reading_site_slug="other-site",
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 404
        # Never touched the model, and never closed someone else's reading.
        assert driver.calls == []
        assert extractions.closed == []

    def test_a_set_id_that_does_not_exist_is_a_404_not_the_nothing_kept_422(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(kept_and_dropped_rows(), driver=driver)

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "999"})

        assert response.status_code == 404
        assert driver.calls == []


class TestAUsedReadingCannotBeAnalysedTwice:
    def test_an_already_used_reading_is_refused_before_any_model_call(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 409
        assert "already been used" in response.text
        assert driver.calls == []

    def test_a_second_submission_of_the_same_reading_does_not_redraft(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(kept_and_dropped_rows(), driver=driver)

        first = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})
        assert first.status_code == 200
        assert extractions.closed == [7]
        calls_after_first = len(driver.calls)

        second = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert second.status_code == 409
        # No second AI call, and the reading was not closed a second time.
        assert len(driver.calls) == calls_after_first
        assert extractions.closed == [7]


class TestTheUploadScreenDescribesWhatActuallyHappens:
    def test_the_working_hint_describes_reading_not_drafting(self):
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text

        assert "drafting prices for every location" not in page
        assert "reading each report on its own" in page

    def test_the_nothing_changes_hint_no_longer_points_below(self):
        client, extractions, store = build_analyse_client([])

        page = " ".join(client.get("/console/sites/baseoil/editorial").text.split())

        assert "review the fetched prices below" not in page
        assert "check what was read on the next screen" in page

    def test_the_dead_image_note_branch_is_gone_from_the_template(self):
        # analyse() always passes image_note=None now -- the block only ever
        # existed for the one-step handler's vision-transcription failures.
        with open("app/templates/editorial.html", encoding="utf-8") as handle:
            source = handle.read()

        assert "image_note" not in source


class TestTheInstructionsBoxCanHoldTheRulebookInIt:
    """A browser renders a textarea's whole value, but once that value is
    longer than the field's own maxlength it refuses every keystroke -- the
    box becomes deletable and not typable. bitumart's rulebook passed 4,000
    characters in September and the box was capped at 4,000, so the editor
    could no longer add a line to his own instructions and had no way of
    knowing why. The cap is a typo guard and nothing more: the column is
    TEXT and save_instructions truncates nothing.
    """

    def rulebook(self, length: int) -> str:
        line = "UK South Domestic - take the first pair exactly as printed.\n"

        return (line * (length // len(line) + 1))[:length]

    def showing(self, text: str) -> str:
        store = AnalyseFakeStore(dataclasses.replace(SITE, editorial_instructions=text))
        client, _, _ = build_analyse_client([], store=store)

        return client.get("/console/sites/baseoil/editorial").text

    def limit_on(self, page: str) -> int:
        box = re.search(r'<textarea[^>]*id="instructions"[^>]*>', page)

        assert box, "the instructions box is not on the screen at all"

        found = re.search(r'maxlength="(\d+)"', box.group(0))

        # No limit at all is a pass: the field then accepts anything.
        return int(found.group(1)) if found else 10**9

    def test_the_box_is_not_smaller_than_the_instructions_it_is_showing(self):
        text = self.rulebook(9000)

        limit = self.limit_on(self.showing(text))

        assert limit >= len(text), (
            f"the saved instructions are {len(text):,} characters and the box stops "
            f"at {limit:,}: the editor cannot type a character into his own rulebook"
        )

    def test_a_long_rulebook_still_reaches_the_screen_whole(self):
        text = self.rulebook(9000)

        page = self.showing(text)

        assert text[:200] in page
        assert text[-200:] in page

    def test_the_box_has_room_for_the_rulebook_to_keep_growing(self):
        # It has gained a paragraph nearly every week since September; a limit
        # sitting just above today's text would fail again next month.
        limit = self.limit_on(self.showing(self.rulebook(9000)))

        assert limit >= 20000, f"only {limit:,} characters, which this text will reach"


class StaleReadingExtractions(AnalyseFakeExtractions):
    """set_by_id answers from a snapshot taken before anyone claimed the
    reading -- which is exactly what the second of two overlapping submits
    sees, because the first is still at the model and has marked nothing
    yet. Only the claim itself knows the truth."""

    def set_by_id(self, set_id):
        reading = super().set_by_id(set_id)

        return dataclasses.replace(reading, used_at=None) if reading is not None else None


class TestTheReadingIsClaimedBeforeAnyModelCall:
    def test_the_claim_happens_before_the_model_is_asked_anything(self):
        events = []

        class Recording(AnalyseFakeExtractions):
            def claim_set(self, set_id):
                events.append("claim")

                return super().claim_set(set_id)

        class Watching(StubDriver):
            def generate(self, model, prompt):
                events.append("model")

                return super().generate(model, prompt)

        driver = Watching(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver
        )
        extractions.__class__ = Recording

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 200
        assert events[0] == "claim"
        assert "model" in events

    def test_a_submit_that_overlaps_another_buys_nothing(self):
        # Read-then-check-then-close let both submits through: both saw
        # used_at empty, both ran the full pair of AI calls, and both billed.
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver
        )
        extractions.__class__ = StaleReadingExtractions

        first = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})
        calls_after_first = len(driver.calls)

        second = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert first.status_code == 200
        assert second.status_code == 409
        assert len(driver.calls) == calls_after_first
        assert extractions.closed == [7]


class TestASpentReadingIsNotADeadEnd:
    """A SiteError at stage time redirects away, the draft is gone, and going
    back got a refusal -- five files to re-upload, ten step-one calls to
    re-pay, every correction to retype. The uploaded reports are not stored,
    so the checked rows are the only copy there is."""

    def test_the_refusal_offers_the_checked_prices_again(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "pricedate": "2026-08-12"},
        )

        assert response.status_code == 409
        assert "Use these prices again" in response.text
        assert 'name="again" value="1"' in response.text
        # The date the editor picked survives the refusal.
        assert 'name="pricedate" value="2026-08-12"' in response.text
        assert driver.calls == []

    def test_pressing_it_runs_the_analysis_again_on_the_same_checked_rows(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={
                "set_id": "7", "again": "1", "pricedate": "2026-08-12",
                "used_at": "2026-08-01T00:00:00",
            },
        )

        assert response.status_code == 200
        assert extractions.reclaimed == [7]
        assert "FOB Asia SN 150" in driver.calls[0]["prompt"]

    def test_an_ordinary_resubmit_is_still_refused(self):
        # The recovery has to be deliberate: a back-button or a double-click
        # must still buy nothing.
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 409
        assert extractions.reclaimed == []
        assert driver.calls == []


class TestAReadingLeftUncheckedIsStillReachable:
    def test_the_upload_screen_links_to_a_reading_that_is_waiting(self):
        client, extractions, store = build_analyse_client(kept_and_dropped_rows())

        page = client.get("/console/sites/baseoil/editorial").text

        assert "A reading is waiting to be checked" in page
        assert 'href="/console/sites/baseoil/reading/7"' in page

    def test_a_used_reading_is_not_offered(self):
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), used_at="2026-08-01T00:00:00",
        )

        page = client.get("/console/sites/baseoil/editorial").text

        assert "A reading is waiting to be checked" not in page


class TestTheFocusedPassGetsTheWholeCheckedRow:
    """benchmarks.py asks the model to fill in "the range printed" and, for a
    non-USD benchmark, "the date the report gives for it". A digest line of
    name, single figure and currency carried neither."""

    @staticmethod
    def _rule():
        return PriceRule(
            id=1, derived_location="Europe Domestic SN150",
            reference_location="Report: FOB Asia SN 150", adjustment_value=-20,
        )

    def test_the_printed_range_reaches_the_focused_prompt(self):
        driver = StubDriver(empty_completion())
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="FOB Asia SN 150", price=1475.0,
                price_min=1450.0, price_max=1500.0, currency="USD", unit="MT", basis="FOB",
                price_date="2026-08-14", note=None, kept=True,
            ),
        ]
        client, extractions, store = build_analyse_client(
            rows, driver=driver, rules_list=[self._rule()]
        )

        client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert "1450-1500" in driver.calls[1]["prompt"]

    def test_the_basis_the_unit_and_the_assessment_date_reach_it_too(self):
        # The Turkey lira benchmarks lost their assessment date here, which
        # left price_date empty, sent convert_rows to the editor's price date
        # instead, and picked today's ECB rate rather than the report's.
        driver = StubDriver(empty_completion())
        rows = [
            ReadRow(
                id=1, set_id=7, filename="lube.docx", name="Ex-rack Izmir SN 150",
                price=81212.0, price_min=None, price_max=None, currency="TRY", unit="MT",
                basis="ex-rack plus VAT", price_date="2026-08-14", note=None, kept=True,
            ),
        ]
        client, extractions, store = build_analyse_client(
            rows, driver=driver, rules_list=[self._rule()]
        )

        client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        focused_prompt = driver.calls[1]["prompt"]

        assert "TRY" in focused_prompt
        assert "MT" in focused_prompt
        assert "ex-rack plus VAT" in focused_prompt
        assert "dated 2026-08-14" in focused_prompt


class TestTheUploadScreenSaysWhatTheFlowActuallyIs:
    def test_the_lede_no_longer_describes_the_deleted_one_step_flow(self):
        client, extractions, store = build_analyse_client([])

        page = " ".join(client.get("/console/sites/baseoil/editorial").text.split())

        assert "fetches a suggested price for every location" not in page
        assert "You review the fetched prices here" not in page

    def test_the_lede_says_read_check_and_use(self):
        client, extractions, store = build_analyse_client([])

        page = " ".join(client.get("/console/sites/baseoil/editorial").text.split())
        lede = page[page.index('<p class="lede">') : page.index("</p>")]

        assert "reads" in lede
        assert "check" in lede
        assert "used" in lede

        for banned in ("drafting", "derived", "parsed", "extraction", "rulebook"):
            assert banned not in lede.lower()

    def test_the_read_button_warns_that_unsaved_instructions_are_ignored(self):
        # read_files reads site.editorial_instructions from the database, so
        # text typed into the box and never saved is simply thrown away.
        client, extractions, store = build_analyse_client([])

        page = " ".join(client.get("/console/sites/baseoil/editorial").text.split())

        assert "as saved" in page
        assert "press <strong>Save instructions</strong> first" in page


class TestReportsCanBeAddedOneAtATime:
    """A plain <input type=file multiple> only ever expresses the files
    chosen together in one dialog -- reopening the picker replaces the first
    choice rather than adding to it. The owner hit this directly: "once i
    upload 1 file there is no option for other files". A first pass fixed
    that with a second, separate "Add another report" button next to the
    picker -- two controls where the owner wanted one, so the picker's own
    on-screen trigger (#doc-trigger) now relabels itself instead once a
    report is in the list. The server-side contract (MAX_DOCUMENTS,
    MAX_DOCUMENT_BYTES, the field name, `multiple`) does not change, so that
    is what is pinned here; the accumulate/merge/duplicate/relabel/disable
    behaviour itself is client-side JavaScript and is not exercised by
    TestClient -- it needs a human click-through."""

    def test_the_real_posting_control_is_unchanged(self):
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text

        assert 'id="documents"' in page
        assert 'name="documents"' in page
        assert "multiple" in page
        assert "required" in page
        assert 'action="/console/sites/baseoil/reading"' in page

    def test_the_single_trigger_control_is_present_and_starts_hidden(self):
        # Progressive enhancement: present in the markup so the script can
        # reveal it (and hide the real input in its place), but hidden until
        # that script actually runs -- there is no separate "Add another"
        # button any more, just this one control relabelling itself.
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text

        trigger_at = page.index('id="doc-trigger"')
        tag_start = page.rindex("<button", 0, trigger_at)
        tag_end = page.index(">", trigger_at)
        trigger_tag = page[tag_start:tag_end]

        assert "Choose files" in page
        assert 'id="doc-add"' not in page
        assert "hidden" in trigger_tag
        assert 'type="button"' in trigger_tag

    def test_the_running_list_and_its_error_slot_are_present_and_start_hidden(self):
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text

        list_at = page.index('id="doc-list"')
        list_tag = page[page.rindex("<ul", 0, list_at) : page.index(">", list_at)]
        error_at = page.index('id="doc-file-error"')
        error_tag = page[page.rindex("<p", 0, error_at) : page.index(">", error_at)]

        assert "hidden" in list_tag
        assert "hidden" in error_tag

    def test_the_limits_shown_come_from_the_same_constants_the_server_enforces(self):
        # Not hardcoded a second time: MAX_DOCUMENTS=5 and MAX_DOCUMENT_BYTES
        # is the same 10 MB read_files() itself refuses an upload over.
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text
        max_mb = MAX_DOCUMENT_BYTES // (1024 * 1024)

        assert f"up to {MAX_DOCUMENTS}" in page
        assert f"{max_mb} MB each" in page
        assert f'data-max-documents="{MAX_DOCUMENTS}"' in page
        assert f'data-max-bytes="{MAX_DOCUMENT_BYTES}"' in page

    def test_the_read_button_is_wired_to_the_upload_form_from_outside_it(self):
        # It now renders after the instructions form (fix #2), so it can only
        # still submit /reading via the form="" attribute, not ancestry.
        client, extractions, store = build_analyse_client([])

        page = client.get("/console/sites/baseoil/editorial").text

        assert 'id="reading-submit"' in page
        assert 'form="reading-form"' in page


class TestAFailedAnalysisDoesNotSwallowTheReading:
    """Claiming before the first model call is right, and it made a new dead
    end: a 502 left used_at set, latest_open filters on used_at IS NULL, and
    the reuse panel only ever renders from a POST that already carries a
    set_id. A closed tab after a 502 meant five reports read, paid for, and
    unreachable."""

    def test_a_provider_failure_hands_the_reading_back(self):
        driver = StubDriver(raises=AiProviderError("Gemini could not be reached"))
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 502
        assert extractions.released == [7]
        assert extractions.set_by_id(7).used_at is None

    def test_after_a_provider_failure_the_editorial_screen_finds_it_again(self):
        driver = StubDriver(raises=AiProviderError("Gemini could not be reached"))
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver
        )

        client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})
        page = client.get("/console/sites/baseoil/editorial").text

        assert "A reading is waiting to be checked" in page
        assert 'href="/console/sites/baseoil/reading/7"' in page

    def test_a_reading_used_but_never_staged_is_still_offered(self):
        # Staging fails in another route entirely, long after the draft was
        # rendered and with no set id to hand, so releasing on failure cannot
        # reach it. It is offered here instead, saying it was used once.
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), used_at="2026-08-01T00:00:00",
        )

        page = client.get("/console/sites/baseoil/editorial").text

        assert "already used once" in page
        assert 'href="/console/sites/baseoil/reading/7"' in page


class TestTheReuseButtonCannotBePressedTwiceByAccident:
    """reclaim_set updated unconditionally and the used_at fast path is
    skipped when again=1, so a refresh or a back-forward after clicking "Use
    these prices again" re-POSTed the same form and bought a second full
    draft behind nothing but the browser's own resubmission dialog."""

    def test_a_stale_reuse_post_never_reaches_the_model(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )
        payload = {
            "set_id": "7", "again": "1", "pricedate": "2026-08-12",
            "used_at": "2026-08-01T00:00:00",
        }

        first = client.post("/console/sites/baseoil/editorial/analyse", data=payload)
        calls_after_first = len(driver.calls)

        # The same form again -- a refresh, or the back-forward cache.
        second = client.post("/console/sites/baseoil/editorial/analyse", data=payload)

        assert first.status_code == 200
        assert second.status_code == 409
        assert len(driver.calls) == calls_after_first
        assert extractions.reclaimed == [7]

    def test_the_refusal_hands_back_a_button_that_does_work(self):
        # The recovery must stay possible: a fresh refusal carries the
        # used_at that is actually there now.
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )

        refusal = client.post(
            "/console/sites/baseoil/editorial/analyse", data={"set_id": "7"}
        )

        assert 'name="used_at" value="2026-08-01T00:00:00"' in refusal.text

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "again": "1", "used_at": "2026-08-01T00:00:00"},
        )

        assert response.status_code == 200
        assert extractions.reclaimed == [7]


class TestAMalformedReuseTokenIsAScreenfulNotACrash:
    """held = str(form_data.get("used_at") or "") used to travel straight into
    reclaim_set's ::timestamptz cast with no guard and no try/except at all.
    A hand-crafted request, stale or corrupted form state, or a browser
    extension sending again=1 with a used_at that is missing, blank or
    garbled made Postgres raise -- an unhandled 500. Not reachable from the
    normally rendered form, so this is hardening, not a live regression."""

    def test_a_missing_used_at_on_again_is_a_screenful_not_a_crash(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )
        extractions.__class__ = RaisingReclaimExtractions

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "again": "1"},  # used_at omitted entirely
        )

        assert response.status_code == 409
        assert "Use these prices again" in response.text
        assert driver.calls == []

    def test_a_blank_used_at_on_again_is_a_screenful_not_a_crash(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )
        extractions.__class__ = RaisingReclaimExtractions

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "again": "1", "used_at": ""},
        )

        assert response.status_code == 409
        assert "Use these prices again" in response.text
        assert driver.calls == []

    def test_a_garbled_used_at_on_again_is_a_screenful_not_a_crash(self):
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )
        extractions.__class__ = RaisingReclaimExtractions

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "again": "1", "used_at": "not-a-timestamp; drop table"},
        )

        assert response.status_code == 409
        assert "Use these prices again" in response.text
        assert driver.calls == []

    def test_a_well_formed_but_stale_token_still_reaches_reclaim_set(self):
        # The guard only screens out gibberish -- a real, merely stale token
        # must still be handed to reclaim_set and fail the compare-and-swap
        # there, exactly as it always has.
        driver = StubDriver(empty_completion())
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), driver=driver, used_at="2026-08-01T00:00:00",
        )
        extractions.__class__ = RaisingReclaimExtractions

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "again": "1", "used_at": "2019-01-01T00:00:00"},
        )

        assert response.status_code == 409
        assert driver.calls == []


class FakeDrafts:
    """Stands in for DraftStore: keeps what it is given, answers like it."""

    def __init__(self, draft_id=12, owner="baseoil"):
        self._draft_id = draft_id
        self._owner = owner
        self.created = []
        self.saved = []

    def create(self, **draft):
        self.created.append(draft)

        return self._draft_id

    def mark_saved(self, draft_id, site_slug, **saved):
        if draft_id != self._draft_id or site_slug != self._owner:
            return False

        self.saved.append({"draft_id": draft_id, "site_slug": site_slug, **saved})

        return True


DRAFT_LOCATIONS = [
    {"title": "Singapore SN 150 FOB Group I", "latest_price": 1500.0},
    {"title": "Europe Domestic SN150", "latest_price": 1000.0},
]


class TestTheAiDraftIsKept:
    def test_every_row_of_the_draft_is_kept_not_only_the_priced_ones(self):
        drafts = FakeDrafts()
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), locations=DRAFT_LOCATIONS, drafts=drafts,
        )

        response = client.post(
            "/console/sites/baseoil/editorial/analyse",
            data={"set_id": "7", "pricedate": "2026-09-24"},
        )

        assert response.status_code == 200
        [draft] = drafts.created
        by_location = {row["location"]: row for row in draft["rows"]}
        # The AI's figure, range, confidence and reasoning -- and the row it
        # found nothing for, which the screen shows unticked.
        singapore = by_location["Singapore SN 150 FOB Group I"]
        assert singapore["status"] == "suggested"
        assert singapore["suggested_price"] == 1560
        assert singapore["confidence"] == "high"
        assert by_location["Europe Domestic SN150"]["status"] == "no_evidence"
        assert draft["site_slug"] == "baseoil"
        assert draft["created_by"] == "editor@local.test"
        assert draft["reading_set_id"] == 7
        assert draft["price_date"] == "2026-09-24"
        assert draft["model"] == "gemini-2.5-flash"

    def test_the_save_form_carries_the_draft_it_came_from(self):
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), locations=DRAFT_LOCATIONS, drafts=FakeDrafts(draft_id=12),
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert '<input type="hidden" name="draft_id" value="12">' in response.text

    def test_a_draft_that_could_not_be_kept_still_reaches_the_editor(self):
        class LosingDrafts(FakeDrafts):
            def create(self, **draft):
                return None

        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), locations=DRAFT_LOCATIONS, drafts=LosingDrafts(),
        )

        response = client.post("/console/sites/baseoil/editorial/analyse", data={"set_id": "7"})

        assert response.status_code == 200
        assert "Singapore SN 150 FOB Group I" in response.text
        assert 'name="draft_id"' not in response.text

    def test_saving_records_what_was_kept_and_at_what_price(self):
        drafts = FakeDrafts(draft_id=12)
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), locations=DRAFT_LOCATIONS, drafts=drafts,
        )

        response = client.post(
            "/console/sites/baseoil/editorial/stage",
            data={
                "pricedate": "2026-09-24", "draft_id": "12",
                # The editor moved the AI's 1560 to 1555 and left Europe off.
                "loc_0": "Singapore SN 150 FOB Group I", "price_0": "1555", "inc_0": "1",
                "loc_1": "Europe Domestic SN150", "price_1": "1010",
            },
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert drafts.saved == [
            {
                "draft_id": 12, "site_slug": "baseoil", "batch_id": 31,
                "saved_by": "editor@local.test",
                "prices": {"Singapore SN 150 FOB Group I": 1555.0},
            }
        ]
        assert store.recorded[-1][3] == "1 row(s) to batch #31, from AI draft #12"

    def test_another_sites_draft_is_not_linked(self):
        drafts = FakeDrafts(draft_id=12, owner="bitumart")
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), locations=DRAFT_LOCATIONS, drafts=drafts,
        )

        client.post(
            "/console/sites/baseoil/editorial/stage",
            data={"draft_id": "12", "loc_0": "Europe Domestic SN150", "price_0": "1010",
                  "inc_0": "1"},
            follow_redirects=False,
        )

        assert drafts.saved == []
        assert store.recorded[-1][3] == "1 row(s) to batch #31"

    def test_a_form_without_a_usable_draft_id_saves_exactly_as_before(self):
        drafts = FakeDrafts()
        client, extractions, store = build_analyse_client(
            kept_and_dropped_rows(), locations=DRAFT_LOCATIONS, drafts=drafts,
        )

        response = client.post(
            "/console/sites/baseoil/editorial/stage",
            data={"draft_id": "garbage", "loc_0": "Europe Domestic SN150", "price_0": "1010",
                  "inc_0": "1"},
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert drafts.saved == []


def stored_draft(batch_id=31, site_slug="baseoil"):
    from app.db.store import DraftRow, StoredDraft

    def row(location, **fields):
        base = dict(
            location=location, is_benchmark=False, status="suggested", reported_as=None,
            current_price=1500.0, suggested_min=1540.0, suggested_max=1580.0,
            suggested_price=1560.0, change_pct=4.0, confidence="high", basis="FOB",
            source="Lube Report", rationale="Printed 1,540-1,580.", flag=None,
            derived_from=None, ticked=None, saved_price=None,
        )
        base.update(fields)

        return DraftRow(**base)

    saved = batch_id is not None

    return StoredDraft(
        id=12, site_slug=site_slug, reading_set_id=7, created_by="editor@local.test",
        created_at="2026-09-24 08:51:11+00:00", price_date="2026-09-24", provider="openai",
        model="gpt-4o-mini", analysis_status="complete", batch_id=batch_id,
        saved_by="editor@local.test" if saved else None, saved_at=None,
        rows=[
            row("Singapore SN 150 FOB Group I", ticked=True if saved else None,
                saved_price=1555.0 if saved else None),
            row("Japan SN 150", ticked=True if saved else None,
                saved_price=1560.0 if saved else None),
            row("Korea SN 150", ticked=False if saved else None),
            row("Europe Domestic SN150", status="no_evidence", suggested_min=None,
                suggested_max=None, suggested_price=None, change_pct=None,
                ticked=False if saved else None),
            row("Report: FOB Asia SN 150", is_benchmark=True, suggested_price=1300.0),
        ],
    )


class ViewableDrafts(FakeDrafts):
    def __init__(self, draft=None, links=None, from_reading=None):
        super().__init__()
        self._draft = draft
        self._links = links or {}
        self._from_reading = from_reading

    def draft(self, draft_id, site_slug):
        if self._draft is None or draft_id != self._draft.id or site_slug != self._draft.site_slug:
            return None

        return self._draft

    def ids_for_batches(self, site_slug, batch_ids):
        return {batch: draft for batch, draft in self._links.items() if batch in batch_ids}

    def latest_for_reading(self, site_slug, set_id):
        return self._from_reading


class ListingSiteClient(AnalyseFakeSiteClient):
    def batches(self):
        return {"data": [
            {"id": 31, "source": "editorial", "status": "draft", "items_count": 2},
            {"id": 29, "source": "api", "status": "committed", "items_count": 40},
        ]}


def build_listing_client(drafts, used_at=None):
    from app.console.routes import datefmt, label_for

    templates = Jinja2Templates(directory="app/templates")
    templates.env.globals["datefmt"] = datefmt
    templates.env.globals["label_for"] = label_for
    app = FastAPI()
    app.include_router(
        create_editorial_routes(
            store=AnalyseFakeStore(), templates=templates,
            current_user=lambda request: type(
                "U", (), {"email": "editor@local.test", "name": "Editor", "is_admin": True, "is_superadmin": True}
            )(),
            driver=StubDriver(), default_model="m",
            client_factory=lambda site: ListingSiteClient([]),
            extractions=AnalyseFakeExtractions(kept_and_dropped_rows(), used_at=used_at),
            drafts=drafts,
        )
    )

    return TestClient(app)


class TestViewingAnAiDraft:
    def test_a_saved_draft_shows_the_ai_figure_beside_what_was_saved(self):
        client = build_listing_client(ViewableDrafts(stored_draft()))

        response = client.get("/console/sites/baseoil/editorial/drafts/12")

        assert response.status_code == 200
        text = response.text
        assert "AI draft #12" in text
        assert "/console/sites/baseoil/prices/31" in text
        # 3 of 4 locations priced; 2 saved, one of them changed by the editor.
        assert "3 of 4 locations got a price from the AI" in text
        assert "the editor changed\n      <strong>1</strong>" in text
        assert "1,555" in text and "1,560" in text
        assert text.count('badge warn">changed') == 1
        assert text.count('badge ok">saved') == 1
        assert text.count('badge mute">not saved') == 1
        # The report figure is shown apart from the site's locations.
        assert "Report figures found" in text

    def test_a_draft_never_saved_says_so(self):
        client = build_listing_client(ViewableDrafts(stored_draft(batch_id=None)))

        response = client.get("/console/sites/baseoil/editorial/drafts/12")

        assert "This draft was never saved" in response.text
        assert "Saved price" not in response.text

    def test_another_sites_draft_is_a_404(self):
        client = build_listing_client(ViewableDrafts(stored_draft(site_slug="bitumart")))

        response = client.get("/console/sites/baseoil/editorial/drafts/12")

        assert response.status_code == 404

    def test_the_recent_updates_list_links_each_update_to_its_draft(self):
        client = build_listing_client(ViewableDrafts(links={31: 12}))

        text = client.get("/console/sites/baseoil/editorial").text

        assert '<a href="/console/sites/baseoil/editorial/drafts/12">View draft</a>' in text
        assert text.count("View draft") == 1

    def test_a_used_reading_offers_the_draft_it_made(self):
        client = build_listing_client(
            ViewableDrafts(from_reading=12), used_at="2026-09-24T08:00:00"
        )

        text = client.get("/console/sites/baseoil/editorial").text

        assert "view the AI draft it made" in text
        assert "/console/sites/baseoil/editorial/drafts/12" in text

    def test_a_failing_lookup_costs_the_links_not_the_screen(self):
        class Broken(ViewableDrafts):
            def ids_for_batches(self, site_slug, batch_ids):
                raise RuntimeError("down")

        response = build_listing_client(Broken()).get("/console/sites/baseoil/editorial")

        assert response.status_code == 200
        assert "Recent price updates" in response.text


def build_text_pdf(page_lines: list[list[str]]) -> bytes:
    """A minimal PDF with one page per entry, each page's lines as real text."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{4 + 2 * n} 0 R" for n in range(len(page_lines)))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_lines)} >>")
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for n, lines in enumerate(page_lines):
        content = "BT /F1 10 Tf 40 740 Td 14 TL\n" + "".join(
            f"({line}) Tj T*\n" for line in lines
        ) + "ET"
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * n} 0 R >>"
        )
        objects.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream")

    out = b"%PDF-1.4\n"
    offsets = []

    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode("latin-1")

    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{offset:010d} 00000 n \n" for offset in offsets).encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    ).encode()

    return out


WHOLE_TABLE = [
    "Mediterranean bitumen prices, 05 - 11 Sep",
    "Italy, including tax 530 545 +35.00 616 634 +42.00",
    "Spain 595 605 nc 692 703 +1.50",
    "Turkey 29,084 29,084 nc 600 600 -2.00",
]
# The same table as the 11 Sep Argus PDF actually yields it: the local
# currency column and the Turkey label are drawn, not written.
DRAWN_TABLE = [
    "Mediterranean bitumen prices, 05 - 11 Sep",
    "Italy, including tax 616",
    "Spain nc 703",
    "nc 600 600 -2.00",
    "601 611 +13.00",
    "Page 6 of 22",
]


class TestPagesWhoseTablesAreDrawn:
    def test_a_page_with_label_less_rows_is_found(self):
        from app.editorial.extract import damaged_pdf_pages

        assert damaged_pdf_pages(build_text_pdf([WHOLE_TABLE, DRAWN_TABLE])) == [1]

    def test_a_whole_table_and_a_lone_page_number_are_not_damage(self):
        from app.editorial.extract import damaged_pdf_pages

        pdf = build_text_pdf([WHOLE_TABLE, ["Some commentary.", "2"]])

        assert damaged_pdf_pages(pdf) == []

    def test_a_line_charts_axis_ticks_are_not_damage(self):
        from app.editorial.extract import damaged_pdf_pages

        # The 25 Sep Argus PDF has a chart on nearly every page, each tick a
        # lone figure on its own line -- it flagged 14 of 19 pages and the
        # picture pass re-read clean tables into duplicate, conflicting rows.
        chart_page = WHOLE_TABLE + ["300", "400", "500", "600", "700", "800", "900"]

        assert damaged_pdf_pages(build_text_pdf([chart_page, DRAWN_TABLE])) == [1]

    def test_the_damaged_page_goes_to_the_vision_model_as_a_picture(self):
        from app.editorial.extract import document_images

        images = document_images("argus.pdf", build_text_pdf([WHOLE_TABLE, DRAWN_TABLE]))

        # Two halves of the one damaged page, so its small figures stay legible.
        assert len(images) == 2

        for mime, data in images:
            assert mime == "image/png"
            assert data[:8] == b"\x89PNG\r\n\x1a\n"

    def test_an_ordinary_text_pdf_still_sends_no_pictures(self):
        from app.editorial.extract import document_images

        assert document_images("argus.pdf", build_text_pdf([WHOLE_TABLE, WHOLE_TABLE])) == []

    def test_the_picture_cap_holds(self):
        from app.editorial.extract import MAX_IMAGES, document_images

        pdf = build_text_pdf([DRAWN_TABLE] * (MAX_IMAGES + 2))

        assert len(document_images("argus.pdf", pdf)) == MAX_IMAGES
