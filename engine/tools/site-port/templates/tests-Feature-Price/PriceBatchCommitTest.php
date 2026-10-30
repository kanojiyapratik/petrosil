<?php

namespace Tests\Feature\Price;

use App\Globalprice;
use App\Location;
use App\PriceBatch;

/**
 * Publishing a staged update, and taking it back.
 *
 * This is the only place on the site where a machine caller changes a live
 * price, so the things worth pinning are: what reaches globalprices, what
 * deliberately does not, and whether the site can be put back the way it was.
 */
class PriceBatchCommitTest extends PriceApiTestCase
{
    const PRICE_DATE = '2026-07-15';
    const PRICED_LOCATION = 'India Paraffin Wax Full Refined CFR';

    private function stage(array $rows)
    {
        $response = $this->acting()->json('POST', '/api/price-batches/rows', [
            'rows' => $rows, 'pricedate' => self::PRICE_DATE,
        ]);

        return $response->json('batch.id');
    }

    private function priceFor($locationTitle)
    {
        $location = Location::where('title', $locationTitle)->first();

        return Globalprice::where('location_id', $location->id)
            ->where('pricedate', self::PRICE_DATE)
            ->whereNull('deleted_at')
            ->orderBy('id', 'desc')
            ->first();
    }

    protected function tearDown(): void
    {
        Globalprice::where('pricedate', self::PRICE_DATE)->forceDelete();

        parent::tearDown();
    }

    public function testCommittingPublishesThePrice()
    {
        $batchId = $this->stage([['location' => self::PRICED_LOCATION, 'price' => 433.25]]);

        $response = $this->acting()->json('POST', "/api/price-batches/{$batchId}/commit", []);

        $response->assertStatus(200);
        $this->assertSame(433.25, (float) $this->priceFor(self::PRICED_LOCATION)->price);
        $this->assertSame(PriceBatch::STATUS_COMMITTED, PriceBatch::find($batchId)->status);
    }

    public function testARowNobodyCouldResolveIsNotPublished()
    {
        $before = Globalprice::count();

        $batchId = $this->stage([
            ['location' => 'Neverland Bulk FOB', 'price' => 500],
        ]);

        $this->acting()->json('POST', "/api/price-batches/{$batchId}/commit", []);

        $this->assertSame(
            $before,
            Globalprice::count(),
            'An unmatched row must never reach the price table.'
        );
    }

    public function testTheSameBatchCannotBePublishedTwice()
    {
        $batchId = $this->stage([['location' => self::PRICED_LOCATION, 'price' => 433.25]]);

        $this->acting()->json('POST', "/api/price-batches/{$batchId}/commit", [])->assertStatus(200);
        $second = $this->acting()->json('POST', "/api/price-batches/{$batchId}/commit", []);

        $this->assertNotEquals(200, $second->status());
    }

    public function testRollingBackTakesThePriceOffTheSite()
    {
        $batchId = $this->stage([['location' => self::PRICED_LOCATION, 'price' => 433.25]]);
        $this->acting()->json('POST', "/api/price-batches/{$batchId}/commit", []);

        $response = $this->acting()->json('POST', "/api/price-batches/{$batchId}/rollback", []);

        $response->assertStatus(200);
        $this->assertSame(PriceBatch::STATUS_ROLLED_BACK, PriceBatch::find($batchId)->status);

        $after = $this->priceFor(self::PRICED_LOCATION);
        $this->assertTrue(
            $after === null || (float) $after->price !== 433.25,
            'The published price should not survive a rollback.'
        );
    }

    public function testADraftCanBeReadBackWithItsRows()
    {
        $batchId = $this->stage([['location' => self::PRICED_LOCATION, 'price' => 433.25]]);

        $response = $this->acting()->getJson("/api/price-batches/{$batchId}");

        $response->assertStatus(200);
        $response->assertJsonPath('batch.status', PriceBatch::STATUS_DRAFT);
        $this->assertSame(self::PRICED_LOCATION, $response->json('items.0.location'));
    }
}
