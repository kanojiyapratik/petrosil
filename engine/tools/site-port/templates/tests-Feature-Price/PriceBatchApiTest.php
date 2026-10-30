<?php

namespace Tests\Feature\Price;

use App\Globalprice;
use App\PriceBatch;
use App\PriceBatchItem;

/**
 * Staging a price update sent by the shared module.
 *
 * Nothing here publishes a price. Rows arrive, each is resolved against this
 * site's locations and compared with what is already held, and the result is
 * a draft that can be looked at before anything goes live.
 */
class PriceBatchApiTest extends PriceApiTestCase
{
    const PRICED_LOCATION = 'India Paraffin Wax Full Refined CFR';

    private $duplicatedLocation;

    protected function setUp(): void
    {
        parent::setUp();

        // A title on two live rows, made fresh here rather than assumed to
        // exist in this site's real data.
        $this->duplicatedLocation = $this->makeLocation('Duplicated Batch Terminal FOB');
        $this->makeLocation('Duplicated Batch Terminal FOB');
    }

    private function stage(array $rows, $pricedate = '2026-07-01', $source = null)
    {
        $payload = ['rows' => $rows, 'pricedate' => $pricedate];

        if ($source !== null) {
            $payload['source'] = $source;
        }

        return $this->acting()->json('POST', '/api/price-batches/rows', $payload);
    }

    private function itemsOf($response)
    {
        $batch = PriceBatch::with('items')->find($response->json('batch.id'));

        return $batch->items;
    }

    public function testItStagesADraftRatherThanPublishingAnything()
    {
        $before = Globalprice::count();

        $response = $this->stage([
            ['location' => self::PRICED_LOCATION, 'price' => 412.5],
        ]);

        $response->assertStatus(201);

        $batch = PriceBatch::find($response->json('batch.id'));
        $this->assertSame(PriceBatch::STATUS_DRAFT, $batch->status);
        $this->assertSame($before, Globalprice::count(), 'Staging must not write a price.');
    }

    public function testAKnownLocationIsResolvedAndPricedAgainstWhatWeHold()
    {
        $response = $this->stage([
            ['location' => self::PRICED_LOCATION, 'price' => 412.5],
        ]);

        $item = $this->itemsOf($response)->first();

        $this->assertNotNull($item->location_id);
        $this->assertSame(412.5, (float) $item->new_price);
        $this->assertContains($item->status, [
            PriceBatchItem::STATUS_NEW,
            PriceBatchItem::STATUS_CHANGED,
            PriceBatchItem::STATUS_UNCHANGED,
        ]);
    }

    public function testTheDuplicatedLocationIsStagedAsAmbiguousNotGuessed()
    {
        $response = $this->stage([
            ['location' => 'Duplicated Batch Terminal FOB', 'price' => 300],
        ]);

        $item = $this->itemsOf($response)->first();

        $this->assertSame(PriceBatchItem::STATUS_AMBIGUOUS, $item->status);
        $this->assertNull($item->location_id);
    }

    public function testALocationThisSiteDoesNotPriceIsStagedAsUnmatched()
    {
        $response = $this->stage([
            ['location' => 'Neverland Bulk FOB', 'price' => 300],
        ]);

        $this->assertSame(PriceBatchItem::STATUS_UNMATCHED, $this->itemsOf($response)->first()->status);
    }

    /**
     * A blank never reaches the staging rules -- it is refused as a malformed
     * request. That matters because PHP would read '' as 0, and a zero here
     * would be a published price of nothing.
     */
    public function testABlankPriceIsRefusedOutright()
    {
        $this->stage([
            ['location' => self::PRICED_LOCATION, 'price' => ''],
        ])->assertStatus(422);
    }

    /** Something that is present but not a number is staged for a human. */
    public function testAPriceThatIsNotANumberIsStagedAsInvalid()
    {
        $response = $this->stage([
            ['location' => self::PRICED_LOCATION, 'price' => 'n/a'],
        ]);

        $item = $this->itemsOf($response)->first();

        $this->assertSame(PriceBatchItem::STATUS_INVALID, $item->status);
    }

    public function testOneBadRowDoesNotThrowAwayTheGoodOnes()
    {
        $response = $this->stage([
            ['location' => self::PRICED_LOCATION, 'price' => 412.5],
            ['location' => 'Neverland Bulk FOB', 'price' => 300],
        ]);

        $response->assertStatus(201);
        $this->assertCount(2, $this->itemsOf($response));
    }

    public function testItRecordsWhereTheRowsCameFrom()
    {
        $response = $this->stage(
            [['location' => self::PRICED_LOCATION, 'price' => 412.5]],
            '2026-07-01',
            PriceBatch::SOURCE_CRAWL
        );

        $this->assertSame(
            PriceBatch::SOURCE_CRAWL,
            PriceBatch::find($response->json('batch.id'))->source
        );
    }

    public function testItRefusesAnEmptyUpdate()
    {
        $this->stage([])->assertStatus(422);
    }

    public function testACallerWithNoTokenIsTurnedAway()
    {
        $response = $this->json('POST', '/api/price-batches/rows', [
            'rows' => [['location' => self::PRICED_LOCATION, 'price' => 1]],
        ]);

        $this->assertContains($response->status(), [401, 403]);
    }
}
