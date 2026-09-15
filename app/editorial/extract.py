"""Turning an uploaded market report into text the model can read.

The parsing lives here and not in the calling site because the sites are PHP
with pre-committed vendor directories: they cannot gain a docx parser, and the
owner's ruling is that the module holds the logic anyway.

docx is read with the standard library -- a docx is a zip holding
word/document.xml, and paragraphs are all a price report needs -- rather than
adding python-docx for one function. PDF reuses the crawler's reader.
"""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET
import zipfile

WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def document_to_text(filename: str, body: bytes) -> str:
    """The text of a report, or "" for a file that cannot be read.

    Unreadable is a normal outcome (a mislabelled upload, a corrupt file), and
    the route turns "every document unreadable" into a 422 -- so this never
    raises.
    """
    name = (filename or "").lower()

    if name.endswith(".docx"):
        return _docx_to_text(body)

    if name.endswith(".xlsx"):
        return _xlsx_to_text(body)

    if name.endswith(".pdf"):
        from scraper.pdf import pdf_to_text

        return pdf_to_text(body)

    if name.endswith(".txt"):
        return body.decode("utf-8", errors="replace").strip()

    return ""


IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

MAX_IMAGES = 6
MAX_IMAGE_BYTES = 4 * 1024 * 1024

# A scanned circular has no text layer at all (the HPCL sample: 0 chars); a
# typed one runs to hundreds or thousands of characters even when short (the
# BPCL sample: 2,953). 200 chars is comfortably above what a stray text run
# or watermark on a scan would leave behind, and comfortably below a genuine
# assessment -- below it the PDF is worth also checking for pictures, at or
# above it the text extractor already did the job and sending its pictures
# to a vision model would just bill a call for a logo.
PDF_TEXT_FLOOR = 200

# A full-page scan of a price table runs to hundreds of kilobytes (the HPCL
# sample: ~690 KB); a logo, signature or letterhead mark sitting in a PDF
# alongside real text is typically a few KB to a few tens of KB. This sits
# well above logo-sized art and well below a scanned page, so it screens out
# decoration without risking a genuine table.
MIN_PDF_IMAGE_BYTES = 20 * 1024

# Only a JPEG (/DCTDecode) embedded image is self-contained bytes a vision
# model can read as-is -- the PDF filter literally means "this stream is a
# JPEG file". Every other PDF image filter (/FlateDecode raw bitmaps,
# /CCITTFaxDecode fax data, /JPXDecode JPEG2000) needs Pillow to become a
# standalone image file, and pillow is not a dependency this module carries
# (pypdf's own page.images needs it too, and raises ImportError without it).
PDF_IMAGE_FILTERS = {"/DCTDecode": "image/jpeg"}

# A price circular is a handful of pages at most; nothing legitimate needs
# hunting for pictures past this many, and it keeps a huge, image-free PDF
# from being walked page by page for no reason.
MAX_PDF_PAGES_FOR_IMAGES = 25


def document_images(filename: str, body: bytes) -> list[tuple[str, bytes]]:
    """The pictures embedded in a docx or PDF, as (mime_type, bytes).

    Reports put whole price tables in as images -- the USA posted prices are
    one, and a scanned circular is nothing but one -- which the text
    extractor cannot see. A vision model transcribes these. Anything
    unreadable is simply no pictures.
    """
    name = (filename or "").lower()

    if name.endswith(".docx"):
        return _docx_images(body)

    if name.endswith(".pdf"):
        return _pdf_images(body)

    return []


def _docx_images(body: bytes) -> list[tuple[str, bytes]]:
    images: list[tuple[str, bytes]] = []

    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            for name in sorted(archive.namelist()):
                if not name.startswith("word/media/"):
                    continue

                suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
                mime = IMAGE_TYPES.get(suffix)

                if mime is None:
                    continue

                data = archive.read(name)

                if 0 < len(data) <= MAX_IMAGE_BYTES:
                    images.append((mime, data))

                if len(images) >= MAX_IMAGES:
                    break
    except (zipfile.BadZipFile, OSError, ValueError):
        return []

    return images


def _pdf_images(body: bytes) -> list[tuple[str, bytes]]:
    # A PDF with a usable text layer already reads fine; harvesting its
    # pictures too would send a report's letterhead or a logo to a vision
    # model on every ordinary upload.
    try:
        from scraper.pdf import pdf_to_text

        if len(pdf_to_text(body)) >= PDF_TEXT_FLOOR:
            return []
    except Exception:  # noqa: BLE001 - a text failure should not block images
        pass

    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - declared in requirements.txt
        return []

    images: list[tuple[str, bytes]] = []

    try:
        reader = PdfReader(io.BytesIO(body))

        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001
                return []

        for page in reader.pages[:MAX_PDF_PAGES_FOR_IMAGES]:
            if len(images) >= MAX_IMAGES:
                break

            try:
                xobjects = page["/Resources"]["/XObject"]
            except KeyError:
                continue

            for xobj_name in xobjects:
                if len(images) >= MAX_IMAGES:
                    break

                # pypdf throws on unusual encodings and filters, and a
                # corrupted embedded picture is not this file's fault --
                # skip that one picture and keep whatever else worked.
                try:
                    xobj = xobjects[xobj_name]

                    if xobj.get("/Subtype") != "/Image":
                        continue

                    filters = xobj.get("/Filter")
                    last_filter = filters[-1] if isinstance(filters, list) else filters
                    mime = PDF_IMAGE_FILTERS.get(last_filter)

                    if mime is None:
                        continue

                    data = xobj.get_data()

                    if MIN_PDF_IMAGE_BYTES <= len(data) <= MAX_IMAGE_BYTES:
                        images.append((mime, bytes(data)))
                except Exception:  # noqa: BLE001
                    continue
    except Exception:  # noqa: BLE001
        return images

    return images


def _xlsx_to_text(body: bytes) -> str:
    """Cell text, one line per row -- enough for the model to read a price
    table. Text lives in xl/sharedStrings.xml (how Excel stores it) or inline;
    numbers sit in the cell itself."""
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            names = archive.namelist()
            shared = []

            if "xl/sharedStrings.xml" in names:
                for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).iter(
                    f"{SHEET_NS}si"
                ):
                    shared.append(
                        "".join(node.text or "" for node in item.iter(f"{SHEET_NS}t"))
                    )

            lines = []

            for name in sorted(n for n in names if n.startswith("xl/worksheets/") and n.endswith(".xml")):
                for row in ET.fromstring(archive.read(name)).iter(f"{SHEET_NS}row"):
                    cells = []

                    for cell in row.iter(f"{SHEET_NS}c"):
                        kind = cell.get("t")
                        value = cell.find(f"{SHEET_NS}v")

                        if kind == "s":
                            at = int(value.text) if value is not None and (value.text or "").isdigit() else -1
                            cells.append(shared[at] if 0 <= at < len(shared) else "")
                        elif kind == "inlineStr":
                            cells.append(
                                "".join(node.text or "" for node in cell.iter(f"{SHEET_NS}t"))
                            )
                        else:
                            cells.append(value.text or "" if value is not None else "")

                    line = " | ".join(cell for cell in cells if cell.strip())

                    if line:
                        lines.append(line)

            return "\n".join(lines)
    except (zipfile.BadZipFile, KeyError, ET.ParseError, OSError, ValueError):
        return ""


def _docx_to_text(body: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            document = archive.read("word/document.xml")

        root = ET.fromstring(document)
    except (zipfile.BadZipFile, KeyError, ET.ParseError, OSError, ValueError):
        return ""

    paragraphs = []

    # Table cells hold their text in w:t nodes too, so iterating paragraphs
    # captures the price tables as well as the prose.
    for paragraph in root.iter(f"{WORD_NS}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{WORD_NS}t"))

        if text.strip():
            paragraphs.append(text)

    return "\n".join(paragraphs)
