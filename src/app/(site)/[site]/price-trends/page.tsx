/** Every market the brand prices, with this week's move — figures for subscribers. */

import { notFound } from "next/navigation";

import { priceTrends } from "@/domain/public/prices";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { Gate, PriceTable, day } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Price trends" };

export default async function PriceTrends({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const q = String((await searchParams).q ?? "").trim().slice(0, 80);
  const reader = await readerFor(brand.id);
  const trends = await priceTrends(brand.id, reader.entitlement.entitled, { search: q || undefined });

  return (
    <section className="bs-card">
      <div className="bs-head">
        <h1>Price trends</h1>
        {trends.asOf ? <span className="muted num">latest assessment {day(trends.asOf)}</span> : null}
      </div>
      <p className="bs-sub">Click a market for its price history.</p>

      <form className="bs-search" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Find a market — grade, port, country…" aria-label="Find a market" />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <Gate site={site} entitlement={reader.entitlement} />

      <div style={{ marginTop: 14 }}>
        {trends.rows.length > 0 ? (
          <PriceTable site={site} rows={trends.rows} />
        ) : (
          <div className="bs-empty">{q ? `No market matches “${q}”.` : "No prices published yet."}</div>
        )}
      </div>
    </section>
  );
}
