"""Turning a fetched page into the small piece of text worth reading.

Two jobs, and the second one is what makes a 15-minute cadence affordable:

1. Strip the markup so the model reads prose and tables, not tag soup.
2. Narrow to the region that actually carries prices, and hash *that*.
   Hashing the whole page would flip on a rotating ad or a "posted 3 hours
   ago" stamp, so every quarter-hour would look like a change and every
   quarter-hour would spend an AI call.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

# Money-shaped tokens. Either a decimal number (3.690, 1,234.50) or an
# integer carrying a currency symbol (₹ 205, $85).
#
# The symbol is what makes the integer form safe to accept: a bare 205 is
# indistinguishable from a year, a count or a viscosity grade, and counting
# those would send the region picker to the wrong part of the page. Requiring
# a decimal point was the earlier rule, and it made whole-rupee listings --
# the normal way Indian sites quote -- invisible, so a page whose prices were
# all integers looked priceless and the region picker centred elsewhere.
PRICE_TOKEN = re.compile(
    r"[$€£₹]\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,3})?"
    r"|\d{1,3}(?:,\d{3})*\.\d{1,3}\b"
)

_SCRIPT = re.compile(r"<script[\s\S]*?</script>", re.IGNORECASE)
_STYLE = re.compile(r"<style[\s\S]*?</style>", re.IGNORECASE)
_COMMENT = re.compile(r"<!--[\s\S]*?-->")
_BLOCK_END = re.compile(r"</(?:tr|p|div|li|h[1-6]|table)>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")

_ENTITIES = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
}


def html_to_text(html: str) -> str:
    """Markup out, readable text in, with block boundaries kept as newlines.

    The newlines matter: without them ``<td>A</td><td>1.10</td>`` collapses
    into ``A 1.10`` run together with the next cell, and two prices merge
    into one unreadable token.
    """
    text = _SCRIPT.sub(" ", html)
    text = _STYLE.sub(" ", text)
    text = _COMMENT.sub(" ", text)
    text = _BLOCK_END.sub("\n", text)
    text = _TAG.sub(" ", text)

    for entity, replacement in _ENTITIES.items():
        text = text.replace(entity, replacement)

    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)

    return text.strip()


def count_price_tokens(text: str) -> int:
    return len(PRICE_TOKEN.findall(text))


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Region:
    text: str
    price_tokens: int


def price_region(text: str, max_chars: int = 8000) -> Region:
    """The window of the page holding the densest cluster of prices."""
    if len(text) <= max_chars:
        return Region(text=text, price_tokens=count_price_tokens(text))

    positions = [match.start() for match in PRICE_TOKEN.finditer(text)]

    if not positions:
        # Nothing price-shaped anywhere. Keep the head so the hash is still
        # stable across runs, and let the caller decide the page is a miss.
        head = text[:max_chars]
        return Region(text=head, price_tokens=0)

    start = max(0, _densest_start(positions, max_chars))
    start = min(start, max(0, len(text) - max_chars))
    window = text[start : start + max_chars]

    return Region(text=window, price_tokens=count_price_tokens(window))


def _densest_start(positions: list[int], size: int) -> int:
    """Start of the ``size``-character window containing the most prices."""
    best_start = positions[0]
    best_count = 0
    right = 0

    for left, start in enumerate(positions):
        while right < len(positions) and positions[right] - start <= size:
            right += 1

        if right - left > best_count:
            best_count = right - left
            best_start = start

    return best_start - 200


def normalise_title(name) -> str:
    """Trimmed, whitespace-collapsed, lowercased.

    Deliberately identical to the rule ``LocationResolver`` uses in PHP. It
    lives here, in the module with no dependencies, because both the database
    layer and the AI layer have to agree with the site about what counts as
    the same location name -- and they only agree if there is one rule.
    """
    if not isinstance(name, str):
        return ""

    return re.sub(r"\s+", " ", name.strip()).lower()


def price_regions(
    text: str, max_chars: int = 8000, max_windows: int = 4
) -> list[Region]:
    """Every part of the page that carries prices, not just the densest.

    A single window round the thickest cluster misses prices that sit
    elsewhere -- measured at 96% coverage on a long chart page, which means a
    handful of real prices silently never reached the model. Windows are laid
    down greedily from the first uncovered price until every one is inside a
    window, or ``max_windows`` is reached.

    The cap is a cost control, not a design: each window is one AI call, and
    they are only ever spent on a page that has actually changed.
    """
    if len(text) <= max_chars:
        return [Region(text=text, price_tokens=count_price_tokens(text))]

    positions = [match.start() for match in PRICE_TOKEN.finditer(text)]

    if not positions:
        return [price_region(text, max_chars)]

    windows: list[Region] = []
    at = 0

    while at < len(positions) and len(windows) < max_windows:
        # Start a little before the first price this window will cover, so a
        # table's header and its row labels come with it.
        start = max(0, positions[at] - 300)
        end = min(len(text), start + max_chars)
        slice_ = text[start:end]
        windows.append(Region(text=slice_, price_tokens=count_price_tokens(slice_)))

        while at < len(positions) and positions[at] < end:
            at += 1

    return windows
