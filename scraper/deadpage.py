"""Spotting a page that is gone but says it is fine.

Plenty of sites answer a missing URL with HTTP 200 and a "Page Not Found"
body. The crawler reads it, finds no prices, and reports `no_rows` -- which is
exactly what it reports for a page that is alive and simply has no prices on
it. The two need very different responses, and nothing distinguished them.

Seen on procurementresource.com: a watched URL started returning 29KB of
"Page Not Found" with a 200, and the screen said "no prices found on the page"
for days without anyone suspecting the URL had died.
"""

from __future__ import annotations

import re

# The wording a dead page uses. Deliberately narrow: these are the phrases
# sites put in a heading, not words that turn up in ordinary prose.
GONE_PHRASES = re.compile(
    r"page not found"
    r"|404 (?:error|not found|page)"
    r"|error 404"
    r"|(?:page|content|article) (?:you (?:are|were) looking for )?"
    r"(?:no longer exists|is no longer available|has been removed|could not be found)"
    r"|sorry,? (?:this|that) page"
    r"|we can'?t find (?:the|that) page"
    r"|this page (?:doesn'?t|does not) exist",
    re.IGNORECASE,
)

# Above this, the phrase is probably a link in a footer or a help article
# rather than the page announcing its own death.
MAX_DEAD_PAGE_CHARS = 6000


def looks_gone(text: str, price_tokens: int) -> bool:
    """True when a 200 response is really a missing page.

    All three conditions have to hold, because any one alone is wrong:
    a short page might be a terse price table, a page with no prices might be
    a legitimate source that stopped publishing, and the phrase alone appears
    in help pages that are very much alive.
    """
    if price_tokens > 0:
        return False

    if len(text) > MAX_DEAD_PAGE_CHARS:
        return False

    return GONE_PHRASES.search(text) is not None
