<?php

namespace Tests\Feature\Price;

use App\PriceSummary;
use Illuminate\Support\Facades\DB;

/**
 * The plain-English note about a published update, and the page that keeps
 * the run of them.
 *
 * This site cannot write one: the AI lives in the shared module, which knows
 * what a committed batch changed. This site's job is to keep the notes and
 * show them.
 *
 * Both pages are public and hide every figure behind a subscription, so a
 * note must never carry a price -- a rule enforced where the note is written,
 * by never showing the model a number.
 */
class PriceSummaryTest extends PriceApiTestCase
{
    protected function tearDown(): void
    {
        DB::table('price_summaries')->delete();

        parent::tearDown();
    }

    private function note($text, $daysAgo = 0, $source = 'editorial')
    {
        $summary = PriceSummary::create(['source' => $source, 'summary' => $text]);

        $when = date('Y-m-d H:i:s', strtotime("-{$daysAgo} days"));
        $summary->created_at = $when;
        $summary->updated_at = $when;
        $summary->save();

        return $summary;
    }

    public function testTheModuleCanPostANote()
    {
        $response = $this->acting()->json('POST', '/api/price-summaries', [
            'summary' => 'Far Eastern wax cargoes softened while European domestic grades held.',
            'source'  => 'crawl',
        ]);

        $response->assertStatus(201);
        $this->assertSame(
            'Far Eastern wax cargoes softened while European domestic grades held.',
            PriceSummary::latest('id')->first()->summary
        );
    }

    public function testAnEmptyNoteIsRefused()
    {
        $response = $this->acting()->json('POST', '/api/price-summaries', [
            'summary' => '   ', 'source' => 'crawl',
        ]);

        $response->assertStatus(422);
        $this->assertSame(0, PriceSummary::count());
    }

    public function testACallerWithNoTokenCannotWriteToThePublicPage()
    {
        $response = $this->json('POST', '/api/price-summaries', [
            'summary' => 'Anyone can write here.', 'source' => 'crawl',
        ]);

        $this->assertContains($response->status(), [401, 403]);
        $this->assertSame(0, PriceSummary::count());
    }

    public function testThePriceTrendsPageShowsTheNewestNote()
    {
        $this->note('Older note.', 5);
        $this->note('Newest note.');

        $response = $this->get('/price-trends');

        $response->assertStatus(200);
        $response->assertSee('Newest note.', false);
        $response->assertDontSee('Older note.', false);
    }

    public function testTheInsightsPageListsTheFortnightNewestFirst()
    {
        $this->note('Nine days ago the Gulf firmed.', 9);
        $this->note('Today Korea eased.');

        $response = $this->get('/ai-market-insights');

        $response->assertStatus(200);
        $response->assertSee('AI Market Insights', false);

        $body = $response->getContent();
        $this->assertTrue(
            strpos($body, 'Today Korea eased.') < strpos($body, 'Nine days ago the Gulf firmed.'),
            'The newest note should appear above the older one.'
        );
    }

    public function testTheInsightsPageLeavesOutAnythingOlderThanAFortnight()
    {
        $this->note('Within the window.', 2);
        $this->note('Three weeks ago, too old.', 21);

        $response = $this->get('/ai-market-insights');

        $response->assertSee('Within the window.', false);
        $response->assertDontSee('Three weeks ago, too old.', false);
    }

    /** Two quiet weeks must not read as a broken page. */
    public function testAQuietFortnightStillShowsTheLastThingWeSaid()
    {
        $this->note('The last thing anyone wrote, a month ago.', 30);

        $response = $this->get('/ai-market-insights');

        $response->assertStatus(200);
        $response->assertSee('The last thing anyone wrote, a month ago.', false);
    }

    public function testBothPagesStandUpWithNoNotesAtAll()
    {
        $this->get('/price-trends')->assertStatus(200);
        $this->get('/ai-market-insights')->assertStatus(200);
    }
}
