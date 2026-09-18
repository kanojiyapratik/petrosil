<?php

namespace Tests\Feature\Price;

/**
 * The first thing the shared price module asks this site for: which locations
 * exist and what each one is currently priced at.
 *
 * This site holds no AI and does no drafting. Everything the module needs has
 * to be reachable by a caller holding nothing but a token, which is why
 * users.api_token exists at all.
 */
class LocationsApiTest extends PriceApiTestCase
{
    const KNOWN_LOCATION = 'India Paraffin Wax Full Refined CFR';

    public function testItListsTheSitesLocations()
    {
        $response = $this->acting()->getJson('/api/locations');

        $response->assertStatus(200);

        $titles = collect($response->json('data'))->pluck('title');
        $this->assertContains(self::KNOWN_LOCATION, $titles->all());
    }

    /**
     * The field names are not ours to choose. The shared module already
     * reads `latest_price` off this list, so this site has to answer in the
     * shape baseoil established or the console screens come up blank
     * against it.
     */
    public function testEachLocationCarriesItsLatestPriceInTheShapeTheModuleReads()
    {
        $response = $this->acting()->getJson('/api/locations');

        $known = collect($response->json('data'))->firstWhere('title', self::KNOWN_LOCATION);

        $this->assertNotNull($known, self::KNOWN_LOCATION . ' should be in the list.');
        $this->assertArrayHasKey('id', $known);
        $this->assertArrayHasKey('latest_price', $known);
        $this->assertArrayHasKey('latest_pricedate', $known);
        $this->assertNotNull($known['latest_price'], self::KNOWN_LOCATION . ' has prices in this database.');
    }

    /** A location nobody has priced yet must come back, with nulls. */
    public function testALocationWithNoPriceStillAppears()
    {
        $this->makeLocation('Brand New Terminal FOB');

        $response = $this->acting()->getJson('/api/locations');

        $fresh = collect($response->json('data'))->firstWhere('title', 'Brand New Terminal FOB');

        $this->assertNotNull($fresh, 'A location with no price should still be listed.');
        $this->assertNull($fresh['latest_price']);
        $this->assertNull($fresh['latest_pricedate']);
    }

    public function testARetiredLocationIsNotOffered()
    {
        $retired = $this->makeLocation('Somewhere Retired FOB');
        $retired->delete();

        $response = $this->acting()->getJson('/api/locations');

        $this->assertNotContains(
            'Somewhere Retired FOB',
            collect($response->json('data'))->pluck('title')->all()
        );
    }

    public function testACallerWithNoTokenIsTurnedAway()
    {
        $response = $this->getJson('/api/locations');

        $this->assertContains($response->status(), [401, 403]);
    }

    /** A person pasting an api URL into a browser must not get a 500. */
    public function testABrowserShapedRequestWithNoTokenIsAlsoTurnedAwayCleanly()
    {
        $response = $this->get('/api/locations');

        $this->assertNotEquals(500, $response->status());
    }
}
