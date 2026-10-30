<?php

namespace Tests\Feature\Price;

use App\PriceCrawlActivity;
use App\PriceCrawlUrl;

/**
 * The API the crawler uses.
 *
 * The crawler runs inside the shared module and knows nothing about this
 * site: not which locations exist, not what a page said last time, not what
 * we already hold. All of that is decided here, which is what lets one
 * deployed crawler serve every Petrosil site.
 */
class PriceCrawlApiTest extends PriceApiTestCase
{
    const LIVE_LOCATION = 'India Paraffin Wax Full Refined CFR';

    protected function setUp(): void
    {
        parent::setUp();

        // A title on two live rows, made fresh here so the "left off the
        // list" assertion does not depend on this site's real data having a
        // duplicate at all.
        $this->makeLocation('Duplicated Crawl Terminal FOB');
        $this->makeLocation('Duplicated Crawl Terminal FOB');
    }

    private function watch($url = 'https://example.com/wax-prices', $enabled = true)
    {
        return PriceCrawlUrl::create([
            'url' => $url, 'enabled' => $enabled, 'created_by' => $this->caller()->id,
        ]);
    }

    private function report(array $results)
    {
        return $this->acting()->json('POST', '/api/price-crawl/results', ['results' => $results]);
    }

    private function readResult(PriceCrawlUrl $url, array $rows, array $extra = [])
    {
        return array_merge([
            'url_id'       => $url->id,
            'status'       => 'read',
            'content_hash' => str_repeat('a', 64),
            'etag'         => 'W/"abc"',
            'rows'         => $rows,
        ], $extra);
    }

    public function testSourcesHandsOverTheWatchListAndTheTrackedLocations()
    {
        $url = $this->watch('https://example.com/one');

        $response = $this->acting()->getJson('/api/price-crawl/sources');

        $response->assertStatus(200);
        $response->assertJsonPath('urls.0.id', $url->id);
        $response->assertJsonPath('urls.0.url', 'https://example.com/one');
        $response->assertJsonPath('interval_minutes', PriceCrawlUrl::CHECK_INTERVAL_MINUTES);
        $this->assertContains(self::LIVE_LOCATION, $response->json('locations'));
    }

    /** A name on two live rows is no use to the model -- it is left out. */
    public function testADuplicatedLocationIsNotOfferedToTheModel()
    {
        $this->watch();

        $response = $this->acting()->getJson('/api/price-crawl/sources');

        $this->assertNotContains('Duplicated Crawl Terminal FOB', $response->json('locations'));
    }

    public function testADisabledUrlIsNotHandedOut()
    {
        $this->watch('https://example.com/off', false);

        $response = $this->acting()->getJson('/api/price-crawl/sources');

        $this->assertEmpty($response->json('urls'));
    }

    public function testAReadPageBecomesActivityAgainstTheSitesLocation()
    {
        $url = $this->watch();

        $response = $this->report([$this->readResult($url, [
            ['location' => self::LIVE_LOCATION, 'price' => 421.5, 'date' => '2026-07-16'],
        ])]);

        $response->assertStatus(201);

        $activity = PriceCrawlActivity::where('price_crawl_url_id', $url->id)->first();
        $this->assertNotNull($activity, 'A price the page quoted should be recorded.');
        $this->assertSame(self::LIVE_LOCATION, $activity->location_name);
        $this->assertSame(421.5, (float) $activity->price);
    }

    public function testTheCrawlerNeverPublishesAPrice()
    {
        $url = $this->watch();
        $before = \App\Globalprice::count();

        $this->report([$this->readResult($url, [
            ['location' => self::LIVE_LOCATION, 'price' => 421.5, 'date' => '2026-07-16'],
        ])]);

        $this->assertSame($before, \App\Globalprice::count(), 'A crawl records, it does not publish.');
    }

    public function testAPageThatCouldNotBeReadDoesNotGetItsHashRemembered()
    {
        // Remembering a hash for a page we failed to read marks it as seen,
        // and it would then be skipped silently for ever.
        $url = $this->watch();

        $this->report([[
            'url_id' => $url->id,
            'status' => 'failed',
            'error'  => 'connection refused',
            'content_hash' => str_repeat('f', 64),
        ]]);

        $this->assertNull($url->fresh()->content_hash);
    }

    public function testAnUnchangedPageIsAcceptedWithoutRows()
    {
        $url = $this->watch();

        $response = $this->report([[
            'url_id' => $url->id,
            'status' => 'unchanged',
        ]]);

        $response->assertStatus(201);
    }

    public function testAnUnknownUrlIsIgnoredRatherThanFailingThePass()
    {
        $url = $this->watch();

        $response = $this->report([
            $this->readResult($url, [
                ['location' => self::LIVE_LOCATION, 'price' => 421.5, 'date' => '2026-07-16'],
            ]),
            ['url_id' => 999999, 'status' => 'read', 'rows' => []],
        ]);

        $response->assertStatus(201);
        $this->assertNotNull(PriceCrawlActivity::where('price_crawl_url_id', $url->id)->first());
    }

    public function testACallerWithNoTokenIsTurnedAway()
    {
        $response = $this->getJson('/api/price-crawl/sources');

        $this->assertContains($response->status(), [401, 403]);
    }
}
