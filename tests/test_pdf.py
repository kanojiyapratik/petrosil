"""Reading a PDF, and deciding that something is one.

Some price publishers put their assessments in a PDF rather than a table, and
the fetcher used to assume HTML, so those sources read as nothing at all.

The fixture here is a real PDF built byte by byte rather than a mock, because
what is being tested is whether a PDF parser can read it.
"""

import zlib

from scraper.pdf import looks_like_pdf, pdf_to_text


def build_pdf(lines: list[str]) -> bytes:
    """A minimal, valid single-page PDF containing the given lines of text.

    Written by hand with a correct cross-reference table: pypdf can often
    recover from a broken one, and a fixture that leans on that recovery would
    be testing the wrong thing.
    """
    content = "BT /F1 12 Tf 40 720 Td 14 TL\n"
    content += "".join(f"({line}) Tj T*\n" for line in lines)
    content += "ET"
    stream = content.encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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


class TestLooksLikePdf:
    def test_believes_the_content_type(self):
        assert looks_like_pdf("application/pdf", b"")
        assert looks_like_pdf("application/pdf; charset=binary", b"")

    def test_believes_the_magic_bytes_over_a_vague_content_type(self):
        # Servers label PDFs as octet-stream often enough that the header
        # alone is not reliable.
        assert looks_like_pdf("application/octet-stream", b"%PDF-1.7\nrest")
        assert looks_like_pdf("", b"%PDF-1.4")

    def test_does_not_mistake_a_web_page_for_one(self):
        # An HTML error page served where a PDF was expected -- exactly what a
        # dead PDF link returns.
        assert not looks_like_pdf("text/html; charset=UTF-8", b"<!DOCTYPE html>")


class TestPdfToText:
    def test_reads_the_text_out_of_a_real_pdf(self):
        pdf = build_pdf(["Base Oil Price Assessment", "Singapore SN 500 845.00", "Mumbai 600.50"])

        text = pdf_to_text(pdf)

        assert "Base Oil Price Assessment" in text
        assert "845.00" in text
        assert "600.50" in text

    def test_its_prices_are_recognisable_to_the_rest_of_the_crawler(self):
        from scraper.normalise import count_price_tokens, price_regions

        pdf = build_pdf(["Singapore 845.00", "Mumbai 600.50", "Rotterdam 1,205.75"])
        text = pdf_to_text(pdf)

        assert count_price_tokens(text) == 3
        assert price_regions(text)[0].price_tokens == 3

    def test_a_file_that_is_not_a_pdf_returns_nothing_rather_than_raising(self):
        # A broken or mislabelled file is the same outcome as a page with no
        # prices on it, and must not take the whole pass down.
        assert pdf_to_text(b"<!DOCTYPE html><p>not a pdf</p>") == ""
        assert pdf_to_text(b"") == ""
        assert pdf_to_text(b"%PDF-1.4 truncated") == ""

    def test_only_the_first_pages_are_read(self):
        # A book-length report is not worth reading in full; every price PDF
        # worth watching puts its table at the front.
        pdf = build_pdf(["Singapore 845.00"])

        assert pdf_to_text(pdf, max_pages=0) == ""
