/**
 * A brand's front page: an opening band with this week's AI note and the
 * brand's numbers, the price list, the newest reports and articles, and the
 * ad slots where the old sites had them.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { priceTrends } from "@/domain/public/prices";
import { insightsFor } from "@/domain/public/insights";
import { publishedArticles } from "@/domain/content/articles";
import { publishedReports } from "@/domain/public/reports";
import { brandLook } from "@/domain/public/look";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { AdSlot, ArticleCard, Gate, PriceTable, day } from "./ui";

export const dynamic = "force-dynamic";

/** How many markets the front page shows before "all prices". */
const SHOWN = 12;

export default async function BrandHome({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const reader = await readerFor(brand.id);
  const [trends, notes, news, research] = await Promise.all([
    priceTrends(brand.id, reader.entitlement.entitled),
    insightsFor(brand.id, { limit: 1 }),
    publishedArticles(brand.id, { limit: 8 }),
    publishedReports(brand.id, { limit: 4 }),
  ]);
  const look = brandLook(brand);
  // The front page shows markets that have a price. Listed in title order,
  // baseoil's twelve slots went half to markets never priced, a column of
  // "no price yet" under "Prices this week"; the full list is one click on.
  const priced = trends.rows.filter((row) => row.price_date !== null);
  const front = priced.length > 0 ? priced : trends.rows;
  const rising = priced.filter((row) => row.movement === "up").length;
  const falling = priced.filter((row) => row.movement === "down").length;

  return (
    <>
      <AdSlot brand={brand} slot="Header Top 1" spaced />

      <section className="bs-hero" aria-labelledby="hero-h">
        <div>
          <div className="eyebrow">{notes.latest ? "This week's market view" : brand.name}</div>
          <h1 id="hero-h">{look.tagline}, assessed every week</h1>
          {notes.latest ? (
            <p className="lede">
              {plainText(notes.latest.summary, 420)}
              <time dateTime={notes.latest.created_at}>
                AI market insight · {day(notes.latest.created_at)} ·{" "}
                <Link href={`/${site}/ai-market-insights`}>Read the full note →</Link>
              </time>
            </p>
          ) : (
            <p className="lede">
              Independent price assessments, market reports and trade data for buyers, sellers and analysts.
            </p>
          )}
          <div className="acts">
            {reader.entitlement.entitled ? (
              <Link className="btn" href={`/${site}/price-trends`}>
                See all prices
              </Link>
            ) : (
              <>
                <Link className="btn" href={`/${site}/subscription`}>
                  Subscribe for full access
                </Link>
                <Link className="btn ghost" href={`/${site}/price-trends`}>
                  Browse markets
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="bs-hero-stats">
          <div>
            <div className="v">{trends.rows.length}</div>
            <div className="k">markets tracked</div>
          </div>
          <div>
            <div className="v">{trends.asOf ? day(trends.asOf).replace(/ \d{4}$/, "") : "—"}</div>
            <div className="k">latest assessment</div>
          </div>
          <div>
            <div className="v">
              <span aria-hidden>▲</span> {rising}
            </div>
            <div className="k">markets up this week</div>
          </div>
          <div>
            <div className="v">
              <span aria-hidden>▼</span> {falling}
            </div>
            <div className="k">markets down this week</div>
          </div>
        </div>
      </section>

      <div className="bs-grid">
        <section className="bs-card" aria-labelledby="prices-h">
          <div className="bs-head">
            <div>
              <h2 id="prices-h">Prices this week</h2>
              {trends.asOf ? <div className="muted" style={{ fontSize: 14, marginTop: 2 }}>Assessed {day(trends.asOf)}</div> : null}
            </div>
            <Link className="more" href={`/${site}/price-trends`}>
              All {trends.rows.length} markets →
            </Link>
          </div>
          {trends.rows.length > 0 ? (
            <PriceTable site={site} rows={front.slice(0, SHOWN)} />
          ) : (
            <div className="bs-empty">No prices published yet.</div>
          )}
          <Gate site={site} entitlement={reader.entitlement} />
        </section>

        <div className="bs-stack">
          <section className="bs-card" aria-labelledby="reports-h">
            <div className="bs-head">
              <h2 id="reports-h">Latest reports</h2>
              <Link className="more" href={`/${site}/reports`}>
                All reports →
              </Link>
            </div>
            {research.reports.length > 0 ? (
              <div className="bs-list">
                {research.reports.map((report) => (
                  <Link key={report.slug} className="bs-row" href={`/${site}/reports/${report.slug}`}>
                    {report.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="thumb" src={report.thumbnail_url} alt="" loading="lazy" />
                    ) : null}
                    <span className="t">
                      {report.title}
                      <span className="d">
                        {day(report.authored_on)}
                        {report.premium ? <span className="bs-tag">Subscribers</span> : null}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="bs-empty">No reports yet.</div>
            )}
          </section>

          <AdSlot brand={brand} slot="Left sidebar 1" />
          <AdSlot brand={brand} slot="Ad Sidebar 3" />
        </div>
      </div>

      {news.articles.length > 0 ? (
        <section className="bs-section" aria-labelledby="news-h">
          <div className="bs-head">
            <h2 id="news-h">Latest articles</h2>
            <Link className="more" href={`/${site}/articles`}>
              All articles →
            </Link>
          </div>
          <div className="bs-cards four">
            {news.articles.map((article) => (
              <ArticleCard key={article.id} site={site} article={article} />
            ))}
          </div>
        </section>
      ) : null}

      <AdSlot brand={brand} slot="carousel" spaced />
    </>
  );
}
