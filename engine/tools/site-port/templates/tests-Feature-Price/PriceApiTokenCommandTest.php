<?php

namespace Tests\Feature\Price;

use App\User;

/**
 * `php artisan price-api:token` -- the only way a service account gets a
 * bearer token to drive this API with.
 */
class PriceApiTokenCommandTest extends PriceApiTestCase
{
    private function makeUser($email)
    {
        $user = User::create([
            'name'     => 'Console account',
            'email'    => $email,
            'password' => bcrypt('secret'),
            'isAdmin'  => 1,
        ]);

        return $user;
    }

    public function testItMintsATokenForAnExistingUser()
    {
        $email = 'console-user' . self::EMAIL_SUFFIX;
        $this->makeUser($email);

        $exitCode = \Illuminate\Support\Facades\Artisan::call('price-api:token', ['email' => $email]);
        $token = trim(\Illuminate\Support\Facades\Artisan::output());

        $this->assertSame(0, $exitCode);
        $this->assertNotEmpty($token);
        $this->assertSame($token, User::where('email', $email)->first()->api_token);
    }

    public function testItRefusesAnUnknownEmail()
    {
        $exitCode = \Illuminate\Support\Facades\Artisan::call('price-api:token', [
            'email' => 'nobody-at-all' . self::EMAIL_SUFFIX,
        ]);

        $this->assertSame(1, $exitCode);
    }
}
