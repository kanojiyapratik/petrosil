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


def document_images(filename: str, body: bytes) -> list[tuple[str, bytes]]:
    """The pictures embedded in a docx, as (mime_type, bytes).

    Reports put whole price tables in as images -- the USA posted prices are
    one -- which the text extractor cannot see. A vision model transcribes
    these. Anything unreadable is simply no pictures.
    """
    if not (filename or "").lower().endswith(".docx"):
        return []

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
