/**
 * A brand's front page: this week's AI note, the price list, the newest
 * articles and reports, and the ad slots where the old sites had them.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { priceTrends } from "@/domain/public/prices";
import { insightsFor } from "@/domain/public/insights";
import { publishedArticles } from "@/domain/content/articles";
import { publishedReports } from "@/domain/public/reports";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { AdSlot, Gate, PriceTable, day } from "./ui";

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
    publishedArticles(brand.id, { limit: 6 }),
    publishedReports(brand.id, { limit: 4 }),
  ]);
  // The front page shows markets that have a price. Listed in title order,
  // baseoil's twelve slots went half to markets never priced, a column of
  // "no price yet" under "Prices this week"; the full list is one click on.
  const priced = trends.rows.filter((row) => row.price_date !== null);
  const front = priced.length > 0 ? priced : trends.rows;

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <AdSlot brand={brand} slot="Header Top 1" />
      </div>

      {notes.latest ? (
        <section className="bs-insight" style={{ marginBottom: 22 }} aria-labelledby="insight-h">
          <div className="eyebrow" id="insight-h">
            AI market insight
          </div>
          <p>{plainText(notes.latest.summary, 1200)}</p>
          <time dateTime={notes.latest.created_at}>
            {day(notes.latest.created_at)} · <Link href={`/${site}/ai-market-insights`}>earlier notes</Link>
          </time>
        </section>
      ) : null}

      <div className="bs-grid">
        <section className="bs-card" aria-labelledby="prices-h">
          <div className="bs-head">
            <h2 id="prices-h">Prices this week</h2>
            {trends.asOf ? <span className="muted num">as of {day(trends.asOf)}</span> : null}
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
                All →
              </Link>
            </div>
            {research.reports.length > 0 ? (
              <div className="bs-list">
                {research.reports.map((report) => (
                  <Link key={report.slug} className="bs-row" href={`/${site}/reports/${report.slug}`}>
                    <span className="t">
                      {report.title}
                      {report.premium ? <span className="bs-tag">Subscribers</span> : null}
                    </span>
                    <time className="num">{day(report.authored_on)}</time>
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

      <section style={{ marginTop: 26 }} aria-labelledby="news-h">
        <div className="bs-head">
          <h2 id="news-h">Latest articles</h2>
          <Link className="more" href={`/${site}/articles`}>
            All articles →
          </Link>
        </div>
        <div className="bs-cards">
          {news.articles.map((article) => (
            <Link key={article.id} className="bs-art" href={`/${site}/articles/${article.slug}`}>
              {article.category ? <div className="cat">{article.category.replace(/-/g, " ")}</div> : null}
              <h3>{article.title}</h3>
              <time dateTime={article.published_at ?? undefined}>{day(article.published_at)}</time>
            </Link>
          ))}
        </div>
      </section>

      <div style={{ marginTop: 26 }}>
        <AdSlot brand={brand} slot="carousel" />
      </div>
    </>
  );
}
