<?php

namespace Tests\Feature\Price;

use App\Location;
use App\Services\Price\LocationMatch;
use App\Services\Price\LocationResolver;

/**
 * Turning a name on a spreadsheet, a report or a watched web page into one of
 * this site's locations.
 *
 * The ambiguous case is made real rather than theoretical by creating two
 * locations that share a title: guessing between them would silently price
 * the wrong one, so the resolver refuses, and the caller is shown the clash
 * instead.
 */
class LocationResolverTest extends PriceApiTestCase
{
    /** A location that ships with this site and always carries a price. */
    const KNOWN_LOCATION = 'India Paraffin Wax Full Refined CFR';

    private function resolver()
    {
        return new LocationResolver();
    }

    public function testItMatchesALocationByItsExactTitle()
    {
        $match = $this->resolver()->resolve(self::KNOWN_LOCATION);

        $this->assertSame(LocationMatch::MATCHED, $match->status);
        $this->assertSame(self::KNOWN_LOCATION, $match->location->title);
    }

    public function testItIgnoresCaseAndUntidySpacing()
    {
        $match = $this->resolver()->resolve('  india   paraffin wax full refined cfr ');

        $this->assertSame(LocationMatch::MATCHED, $match->status);
        $this->assertSame(self::KNOWN_LOCATION, $match->location->title);
    }

    public function testATitleOnTwoLiveRowsIsRefusedRatherThanGuessed()
    {
        $this->makeLocation('Duplicated Test Terminal FOB');
        $this->makeLocation('Duplicated Test Terminal FOB');

        $match = $this->resolver()->resolve('Duplicated Test Terminal FOB');

        $this->assertSame(LocationMatch::AMBIGUOUS, $match->status);
        $this->assertNull($match->location);
        $this->assertGreaterThan(1, count($match->candidates));
    }

    public function testANameThisSiteDoesNotPriceIsUnmatched()
    {
        $match = $this->resolver()->resolve('Neverland Bulk FOB');

        $this->assertSame(LocationMatch::UNMATCHED, $match->status);
        $this->assertNull($match->location);
    }

    public function testAnEmptyNameIsUnmatchedRatherThanAnError()
    {
        $this->assertSame(LocationMatch::UNMATCHED, $this->resolver()->resolve('   ')->status);
        $this->assertSame(LocationMatch::UNMATCHED, $this->resolver()->resolve(null)->status);
    }

    public function testARetiredLocationIsNotMatchedAgainst()
    {
        $retired = $this->makeLocation('Closed Refinery FOB');
        $retired->delete();

        $this->assertSame(
            LocationMatch::UNMATCHED,
            $this->resolver()->resolve('Closed Refinery FOB')->status
        );
    }
}
