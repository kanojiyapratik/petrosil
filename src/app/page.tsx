/**
 * The front door: Petrosil and its brands.
 *
 * Every brand lives at its own path (`/baseoil`, `/bitumart`, …), so the bare
 * address needs a page that says what Petrosil is and leads to each of them.
 * It used to send everyone to the admin's sign-in, which is a dead end for a
 * reader. Staff still find their way in from the footer.
 */

import "./(site)/site.css";

import Link from "next/link";
import type { Metadata } from "next";
import { and, eq, isNull, max } from "drizzle-orm";

import { db } from "@/db";
import { prices, sites } from "@/db/schema";
import { brandLook } from "@/domain/public/look";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Petrosil — market intelligence",
  description: "Prices, reports and market news for base oils, bitumen, waxes, chemicals and more.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const [y, m, d] = value.slice(0, 10).split("-").map(Number);

  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : null;
}

export default async function Home() {
  const [brands, latest] = await Promise.all([
    db().select().from(sites).where(eq(sites.enabled, true)).orderBy(sites.name),
    db()
      .select({ siteId: prices.siteId, last: max(prices.priceDate) })
      .from(prices)
      .where(and(isNull(prices.deletedAt)))
      .groupBy(prices.siteId),
  ]);

  const updated = new Map(latest.map((row) => [row.siteId, row.last]));

  return (
    <div className="bs" style={{ "--brand": "#16324a" } as React.CSSProperties}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Source+Sans+3:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
      />

      <header className="bs-mast">
        <div className="wrap bs-mast-in">
          <span className="bs-logo">Petrosil</span>
        </div>
      </header>

      <main className="wrap bs-main">
        <section className="bs-home-head">
          <h1>Market intelligence, one market at a time</h1>
          <p className="muted">
            Weekly prices, market reports and news for the industries we cover. Each publication has its own prices, reports and
            subscription.
          </p>
        </section>

        <div className="bs-home-grid">
          {brands.map((brand) => {
            const look = brandLook(brand);
            const last = day(updated.get(brand.id) ?? null);

            return (
              <Link
                key={brand.id}
                className="bs-home-card"
                href={`/${brand.slug}`}
                style={{ "--brand": look.color } as React.CSSProperties}
              >
                <h2>{brand.name}</h2>
                <p>{look.tagline}</p>
                <span className="small muted">{last ? `Prices updated ${last}` : "Prices coming soon"}</span>
              </Link>
            );
          })}
        </div>
      </main>

      <footer className="bs-foot">
        <div className="wrap bs-foot-in">
          <p className="fine">
            © {new Date().getFullYear()} Petrosil. <Link href="/sign-in">Staff sign in</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
