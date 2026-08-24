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


def document_to_text(filename: str, body: bytes) -> str:
    """The text of a report, or "" for a file that cannot be read.

    Unreadable is a normal outcome (a mislabelled upload, a corrupt file), and
    the route turns "every document unreadable" into a 422 -- so this never
    raises.
    """
    name = (filename or "").lower()

    if name.endswith(".docx"):
        return _docx_to_text(body)

    if name.endswith(".pdf"):
        from scraper.pdf import pdf_to_text

        return pdf_to_text(body)

    if name.endswith(".txt"):
        return body.decode("utf-8", errors="replace").strip()

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
