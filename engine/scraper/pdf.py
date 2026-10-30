"""Reading a PDF the same way we read a page.

Some price publishers put their assessments in a PDF rather than a table, and
until now the fetcher assumed HTML and those sources read as nothing at all.

The output goes through exactly the same path as a web page -- price regions,
hash, model -- so a PDF source behaves like any other watched URL. Nothing
downstream needs to know which it was.
"""

from __future__ import annotations

import io
import logging
import re

logger = logging.getLogger(__name__)

# A PDF whose text layer is enormous is almost always a scanned document with
# OCR, or a report that happens to be book-length. Reading the first pages is
# what a person would do; the price table is at the front in every price PDF
# worth watching.
MAX_PAGES = 25


def looks_like_pdf(content_type: str, body: bytes) -> bool:
    """Content-Type first, magic bytes second.

    Servers mislabel PDFs as octet-stream often enough that the header alone
    is not reliable, and a file that begins %PDF- is a PDF whatever the server
    claims.
    """
    if "application/pdf" in (content_type or "").lower():
        return True

    return body[:5] == b"%PDF-"


def pdf_needs_password(body: bytes) -> bool:
    """True only for a PDF that a blank password does not open.

    Argus sends its reports AES-encrypted with no password to open them
    (copy and print are what is locked). Those read fine; this picks out the
    rare file that is really locked, so it can be named as such rather than
    as "could not be read".
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(body))

        return bool(reader.is_encrypted) and not reader.decrypt("")
    except Exception:  # noqa: BLE001 - unreadable for some other reason
        return False


def pdf_to_text(body: bytes, max_pages: int = MAX_PAGES) -> str:
    """The PDF's text, or an empty string if it has none to give.

    A PDF that cannot be parsed, is encrypted, or is a scan with no text layer
    returns "" rather than raising: to the crawler that is the same outcome as
    a page with no prices on it, and it must not take the pass down.
    """
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - the dependency is declared
        logger.error("pypdf is not installed, so PDFs cannot be read")
        return ""

    try:
        reader = PdfReader(io.BytesIO(body))

        if reader.is_encrypted:
            # An empty password opens many "protected" PDFs; a real one is a
            # document we were not meant to read.
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001
                logger.info("PDF is encrypted and could not be opened")
                return ""

        pages = reader.pages[:max_pages]
        text = "\n".join((page.extract_text() or "") for page in pages)
    except Exception as error:  # noqa: BLE001 - a broken PDF is not a crash
        logger.info("PDF could not be read: %s", error)
        return ""

    # PDF extraction leaves ragged spacing that would split "1,835.00" across
    # a line break and stop it being recognised as a price.
    text = text.replace(" ", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)

    return text.strip()
