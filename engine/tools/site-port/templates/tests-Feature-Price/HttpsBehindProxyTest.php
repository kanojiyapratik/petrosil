<?php

namespace Tests\Feature\Price;

/**
 * Asset URLs when the site sits behind a TLS-terminating proxy.
 *
 * Docker (and any CDN or load balancer in front of this site) accepts https
 * from the visitor and forwards plain http to the container, saying so in
 * X-Forwarded-Proto. Laravel only believes that header from a proxy it has
 * been told to trust. Untrusted, it decides the request was http and writes
 * every stylesheet and script tag as http://... -- which a browser on an
 * https page refuses to load as mixed content. The site then renders with no
 * CSS at all.
 */
class HttpsBehindProxyTest extends PriceApiTestCase
{
    public function testAssetsAreWrittenAsHttpsWhenTheProxySaysTheRequestWas()
    {
        $response = $this->withHeaders(['X-Forwarded-Proto' => 'https'])->get('/price-trends');

        $response->assertStatus(200);

        $body = $response->getContent();
        preg_match_all('~<link[^>]+href="(http://[^"]+/static/[^"]+)"~i', $body, $insecure);

        $this->assertEmpty(
            $insecure[1],
            "Stylesheets were written as http on an https request:\n  " .
                implode("\n  ", array_slice($insecure[1], 0, 5))
        );
    }

    public function testItStillUsesHttpWhenNothingClaimsOtherwise()
    {
        $response = $this->get('/price-trends');

        $response->assertStatus(200);
    }
}
