"""Telling a dead URL from a page that simply has no prices.

Both used to report `no_rows`, and they need very different responses: one
means find the new address, the other means nothing happened today.
"""

from scraper.deadpage import looks_gone


class TestLooksGone:
    def test_spots_the_usual_wording(self):
        for body in [
            "Page Not Found",
            "404 Error - the page you requested",
            "Sorry, this page is no longer available",
            "We can't find that page",
            "This page doesn't exist",
        ]:
            assert looks_gone(body, 0), body

    def test_a_page_with_prices_on_it_is_alive_whatever_it_says(self):
        # A help article about 404s is a real page. So is a price page that
        # happens to mention one.
        assert not looks_gone("Page Not Found. Singapore 845.00", 3)

    def test_a_long_page_is_not_a_404_page(self):
        # The phrase in a footer or a help centre, not the page announcing
        # its own death.
        assert not looks_gone("page not found " + ("filler " * 2000), 0)

    def test_an_ordinary_empty_page_is_not_called_dead(self):
        # No prices today is not the same as the URL being wrong, and saying
        # so would send someone hunting for a new address that exists.
        assert not looks_gone("Our weekly assessment will be published Friday.", 0)

    def test_an_empty_body_is_not_evidence_of_anything(self):
        assert not looks_gone("", 0)
