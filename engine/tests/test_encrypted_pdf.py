"""Encrypted PDFs that open with no password are read like any other.

Argus's 25-Sep-26 report is AES-encrypted with a blank open-password (only
copying and printing are locked). pypdf needs the cryptography package for
AES; without it the decrypt failed quietly and the console said "could not
be read" for a report that opens fine in any viewer.
"""

import io

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, StreamObject

from app.editorial.extract import document_to_text
from scraper.pdf import pdf_needs_password, pdf_to_text


def pdf_with_text(text: str, user_password: str | None = None) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=200)
    font = writer._add_object(  # noqa: SLF001 - smallest way to a real text layer
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )
    content = StreamObject()
    content.set_data(f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(content)  # noqa: SLF001

    if user_password is not None:
        writer.encrypt(user_password=user_password, owner_password="owner", algorithm="AES-256")

    out = io.BytesIO()
    writer.write(out)

    return out.getvalue()


def test_an_aes_pdf_with_no_open_password_is_read():
    body = pdf_with_text("Antwerp, Belgium 505 520", user_password="")

    assert "Antwerp, Belgium 505 520" in pdf_to_text(body)
    assert "505 520" in document_to_text("Argus Report (25.09.26).pdf", body)
    assert pdf_needs_password(body) is False


def test_a_pdf_locked_with_a_real_password_is_named_as_locked():
    body = pdf_with_text("Antwerp, Belgium 505 520", user_password="secret")

    assert pdf_to_text(body) == ""
    assert pdf_needs_password(body) is True


def test_a_plain_pdf_needs_no_password():
    assert pdf_needs_password(pdf_with_text("Turkey 600")) is False


def test_something_that_is_not_a_pdf_is_not_called_locked():
    assert pdf_needs_password(b"not a pdf") is False
