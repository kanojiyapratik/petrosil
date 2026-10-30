<?php

namespace Tests\Feature\Price;

use App\User;
use Illuminate\Foundation\Testing\DatabaseTransactions;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Shared setup for the price API tests.
 *
 * The cleanup here is not tidiness. Most of this database is MyISAM, which
 * has no transactions, so DatabaseTransactions rolls back price_batches and
 * price_batch_items -- InnoDB, created by our own migrations -- and silently
 * does nothing for `users`. Without this the test database collects a caller
 * per test per run for ever.
 *
 * `globalprices` was converted to InnoDB for the same reason, and for a
 * better one: a price commit is wrapped in a transaction it could not honour.
 */
abstract class PriceApiTestCase extends TestCase
{
    use DatabaseTransactions;

    /** Every caller these tests create, so tearDown can find them again. */
    const EMAIL_SUFFIX = '@price-test.local';

    private $callerUser;

    /** Locations these tests invented, to be removed again in tearDown. */
    private $madeLocations = [];

    protected function tearDown(): void
    {
        DB::table('users')->where('email', 'like', '%' . self::EMAIL_SUFFIX)->delete();

        if ($this->madeLocations) {
            DB::table('globalprices')->whereIn('location_id', $this->madeLocations)->delete();
            DB::table('locations')->whereIn('id', $this->madeLocations)->delete();
            $this->madeLocations = [];
        }

        parent::tearDown();
    }

    /**
     * A location that exists only for this test.
     *
     * `locations` is MyISAM, so creating one inside a test is permanent
     * unless it is cleaned up here. Leaving one behind is not untidiness: an
     * unpriced location breaks the price trends page, so a leaked one makes
     * every later run of that test fail for the wrong reason.
     */
    protected function makeLocation($title)
    {
        $location = \App\Location::create(['title' => $title]);

        $this->madeLocations[] = $location->id;

        return $location;
    }

    /**
     * A caller holding a token and the role the price endpoints require.
     * One per test: users.api_token is unique.
     */
    protected function caller()
    {
        if ($this->callerUser !== null) {
            return $this->callerUser;
        }

        $user = User::create([
            'name'              => 'Price module',
            'email'             => strtolower(class_basename(static::class)) . self::EMAIL_SUFFIX,
            'password'          => bcrypt('secret'),
            'isAdmin'           => 1,
            'api_token'         => substr(str_repeat(md5(static::class), 3), 0, 60),
            'email_verified_at' => date('Y-m-d H:i:s'),
        ]);

        // The price endpoints are permission-gated, so a caller with a valid
        // token but no role is still refused -- which is the point of them.
        $user->assignRole('super-admin');

        return $this->callerUser = $user;
    }

    /** Acting as that caller, on the token guard. */
    protected function acting()
    {
        return $this->actingAs($this->caller(), 'api');
    }
}
