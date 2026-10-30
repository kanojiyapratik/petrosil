/**
 * The trade board: members' offers to buy and to sell, newest first. Who
 * posted it and how to reach them follows the brand's field rules.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { publishedOffers } from "@/domain/public/offers";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { Pager, day, pageParam } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offers" };

const PER_PAGE = 30;
const TYPES = [
  { key: "", label: "All" },
  { key: "sell", label: "For sale" },
  { key: "buy", label: "Wanted" },
];

export default async function Offers({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ q?: string; type?: string; page?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const query = await searchParams;
  const q = String(query.q ?? "").trim().slice(0, 80);
  const type = query.type === "buy" || query.type === "sell" ? query.type : "";
  const page = pageParam(query.page);

  const reader = await readerFor(brand.id);
  const found = await publishedOffers(brand.id, reader.entitlement, {
    type: type || undefined,
    search: q || undefined,
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });
  const pages = Math.ceil(found.total / PER_PAGE);
  const kept = { ...(q ? { q } : {}), ...(type ? { type } : {}) };

  return (
    <section>
      <div className="bs-head">
        <h1>Offers</h1>
        <span className="muted num">{found.total.toLocaleString("en-US")} live</span>
        <span className="more">
          {reader.name ? <Link href={`/${site}/offers/mine`}>My offers</Link> : null}{" "}
          <Link className="btn" href={`/${site}/offers/new`}>
            Post an offer
          </Link>
        </span>
      </div>

      <form className="bs-search" role="search">
        {type ? <input type="hidden" name="type" value={type} /> : null}
        <input type="search" name="q" defaultValue={q} placeholder="Search offers…" aria-label="Search offers" />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <nav className="bs-chips" aria-label="Kind of offer">
        {TYPES.map((t) => (
          <Link
            key={t.key}
            href={`/${site}/offers${(() => {
              const next = new URLSearchParams({ ...(q ? { q } : {}), ...(t.key ? { type: t.key } : {}) }).toString();

              return next ? `?${next}` : "";
            })()}`}
            aria-current={type === t.key ? "true" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {found.offers.length > 0 ? (
        <div className="bs-list">
          {found.offers.map((offer) => (
            <Link key={offer.id} className="bs-row" href={`/${site}/offers/${offer.id}`}>
              <span className={`bs-kind ${offer.offer_type}`}>{offer.offer_type === "buy" ? "Wanted" : "For sale"}</span>
              <span className="t">
                {offer.subject}
                {offer.description ? <span className="d">{plainText(offer.description, 140)}</span> : null}
              </span>
              <span className="m">{[offer.city, offer.country].filter(Boolean).join(", ")}</span>
              <time dateTime={offer.posted_on}>{day(offer.posted_on)}</time>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bs-empty">{q || type ? "No offer matches that." : "No offers here yet."}</div>
      )}

      <Pager base={`/${site}/offers`} page={page} pages={pages} query={kept} />
    </section>
  );
}
