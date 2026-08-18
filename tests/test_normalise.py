from scraper.normalise import (
    count_price_tokens,
    hash_text,
    html_to_text,
    price_region,
)

FILLER = "navigation and boilerplate text " * 400


class TestHtmlToText:
    def test_drops_scripts_styles_and_tags(self):
        html = (
            "<html><head><style>.a{color:red}</style>"
            "<script>var x = 1;</script></head><body>"
            "<table><tr><td>Gulf Coast</td><td>3.690</td></tr></table>"
            "</body></html>"
        )

        text = html_to_text(html)

        assert "Gulf Coast" in text
        assert "3.690" in text
        assert "var x" not in text
        assert "color:red" not in text

    def test_keeps_rows_apart_so_two_prices_stay_two_tokens(self):
        text = html_to_text(
            "<tr><td>A</td><td>1.10</td></tr><tr><td>B</td><td>2.20</td></tr>"
        )

        assert count_price_tokens(text) == 2

    def test_decodes_the_entities_that_actually_appear(self):
        assert "Brent & WTI" in html_to_text("<p>Brent &amp; WTI</p>")


class TestCountPriceTokens:
    def test_counts_money_shaped_numbers(self):
        assert count_price_tokens("U.S. 4.096 Gulf Coast $3.69 and 1,234.50") == 3

    def test_ignores_bare_integers_and_years(self):
        assert count_price_tokens("In 2026 the index moved 12 points") == 0


class TestPriceRegion:
    def test_returns_a_short_page_whole(self):
        region = price_region("Singapore 845.00")

        assert region.text == "Singapore 845.00"
        assert region.price_tokens == 1

    def test_narrows_a_long_page_to_where_the_prices_are(self):
        prices = "Singapore 845.00 Mumbai 600.50 Rotterdam 712.25 "
        region = price_region(FILLER + prices + FILLER, max_chars=2000)

        assert "Singapore 845.00" in region.text
        assert "Rotterdam 712.25" in region.text
        assert len(region.text) <= 2000

    def test_keeps_the_head_when_a_page_has_no_prices(self):
        region = price_region(FILLER, max_chars=500)

        assert region.price_tokens == 0
        assert len(region.text) == 500


class TestHashText:
    def test_is_stable_for_the_same_text(self):
        assert hash_text("Singapore 845.00") == hash_text("Singapore 845.00")
        assert hash_text("Singapore 845.00") != hash_text("Singapore 846.00")

    def test_ignores_boilerplate_outside_the_price_region(self):
        # Two checks fifteen minutes apart: the ad slot changed, the prices
        # did not. Hashing the region rather than the page is what stops that
        # becoming ninety-six AI calls a day.
        day_one = price_region("ad-slot-19281 " + "x " * 3000 + "Singapore 845.00", 400)
        day_two = price_region("ad-slot-55512 " + "x " * 3000 + "Singapore 845.00", 400)

        assert hash_text(day_one.text) == hash_text(day_two.text)
