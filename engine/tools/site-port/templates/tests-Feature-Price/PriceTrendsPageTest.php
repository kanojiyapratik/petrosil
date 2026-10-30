<?php

namespace Tests\Feature\Price;

/**
 * The public price trends page.
 *
 * Every location here happens to have a price today, which is the only
 * reason this page stood up before: the row reached straight into the newest
 * price. Adding a location before pricing it took the same page down on
 * baseoil, and the price module makes adding locations easy.
 */
class PriceTrendsPageTest extends PriceApiTestCase
{
    public function testItListsTheLocationsWePrice()
    {
        $response = $this->get('/price-trends');

        $response->assertStatus(200);
        $response->assertSee('India Paraffin Wax Full Refined CFR', false);
    }

    public function testALocationWithNoPriceDoesNotTakeThePageDown()
    {
        $this->makeLocation('Unpriced Terminal FOB');

        $response = $this->get('/price-trends');

        $response->assertStatus(200);
        $response->assertSee('Unpriced Terminal FOB', false);
    }
}
