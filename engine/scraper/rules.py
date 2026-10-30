"""Reading prices without the model.

Not a replacement for it -- a way to answer a different question. When a pass
returns nothing, the useful thing to know is whether the crawler failed to
fetch the page or the model failed to read it, and with only the AI path there
is no way to tell them apart. This reads the same text with plain rules, so a
pass can be run with no API key, no quota and no cost.

It is deliberately dumber than the model and does not pretend otherwise: it
takes the words immediately before a price on the same line as that price's
label. That works on a table and falls apart on prose, which is exactly why
the model does the real job.
"""

from __future__ import annotations

import re

from .ai import Extraction, ExtractedRow, to_price
from .normalise import PRICE_TOKEN, normalise_title

# Words that mean the number beside them is not a price level.
NOT_A_PRICE = re.compile(
    r"%|percent|per cent|change|volume|index|year[- ]on[- ]year|yoy|"
    r"barrels|bbl/d|million|billion|phone|tel|fax|©|copyright",
    re.IGNORECASE,
)

# A label longer than this is a sentence, not a row label.
MAX_LABEL_CHARS = 80


class RuleExtractor:
    """Same interface as GeminiExtractor, so the runner cannot tell them apart."""

    def extract(self, url: str, text: str, locations: list[str], today: str) -> Extraction:
        canonical = {normalise_title(name): name for name in locations}
        rows: list[ExtractedRow] = []
        seen: set[tuple[str, str]] = set()

        for line in text.splitlines():
            if NOT_A_PRICE.search(line):
                continue

            match = PRICE_TOKEN.search(line)

            if match is None:
                continue

            price = to_price(re.sub(r"[^0-9.,]", "", match.group(0)).replace(",", ""))

            if price is None or price <= 0:
                continue

            label = _label_before(line, match.start())

            if label == "":
                continue

            # Snapped to the site's own spelling when it matches one, exactly
            # as the model's output is, so both paths produce the same shape.
            location = canonical.get(normalise_title(label), label)
            key = (location, today)

            if key in seen:
                continue

            seen.add(key)
            rows.append(ExtractedRow(location=location, date=today, price=price))

        return Extraction(
            rows=rows,
            notes=(
                "Read with rules rather than AI: the label is whatever text preceded the "
                "price on its line. Good enough to prove the crawler is fetching and "
                "parsing; not good enough to publish from."
            ),
            declined=False,
            error=None,
        )


def _label_before(line: str, at: int) -> str:
    """The words immediately before the price, trimmed to something label-like."""
    label = line[:at].strip(" \t|:-–— ")

    # Drop a leading serial number or bullet, which would otherwise become
    # part of every label in a numbered table.
    label = re.sub(r"^\d+[.)]\s*", "", label)

    if len(label) > MAX_LABEL_CHARS:
        label = label[-MAX_LABEL_CHARS:].lstrip()

    return label.strip()
