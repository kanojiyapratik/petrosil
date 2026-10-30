/**
 * The members' directory: companies that joined this brand, by name, country
 * and first letter, with paying members marked. What each reader sees of a
 * company follows the brand's field rules (`visibleDirectoryFields`).
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { directory } from "@/domain/public/directory";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { Gate, Pager, pageParam } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Directory" };

const PER_PAGE = 30;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const TIERS = [
  { key: "", label: "All" },
  { key: "premium", label: "Premium members" },
  { key: "free", label: "Other members" },
];

export default async function Directory({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ q?: string; tier?: string; country?: string; letter?: string; page?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const query = await searchParams;
  const q = String(query.q ?? "").trim().slice(0, 80);
  const tier = query.tier === "premium" || query.tier === "free" ? query.tier : "";
  const country = String(query.country ?? "").trim().slice(0, 96);
  const letter = /^[A-Z]$/i.test(String(query.letter ?? "")) ? String(query.letter).toUpperCase() : "";
  const page = pageParam(query.page);

  const reader = await readerFor(brand.id);
  const found = await directory(brand.id, reader.entitlement, {
    search: q || undefined,
    tier: tier || undefined,
    country: country || undefined,
    letter: letter || undefined,
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });

  const pages = Math.ceil(found.total / PER_PAGE);
  const kept = { ...(q ? { q } : {}), ...(tier ? { tier } : {}), ...(country ? { country } : {}), ...(letter ? { letter } : {}) };
  const link = (change: Record<string, string>) => {
    const next = new URLSearchParams({ ...kept, ...change });

    for (const [key, value] of [...next.entries()]) {
      if (!value) next.delete(key);
    }

    const text = next.toString();

    return `/${site}/directory${text ? `?${text}` : ""}`;
  };

  return (
    <section>
      <div className="bs-head">
        <h1>Directory</h1>
        <span className="muted num">{found.total.toLocaleString("en-US")} companies</span>
      </div>

      <form className="bs-search" role="search">
        {tier ? <input type="hidden" name="tier" value={tier} /> : null}
        {letter ? <input type="hidden" name="letter" value={letter} /> : null}
        <input type="search" name="q" defaultValue={q} placeholder="Search companies and people…" aria-label="Search the directory" />
        {found.countries.length > 0 ? (
          <select name="country" defaultValue={country} aria-label="Country">
            <option value="">Every country</option>
            {found.countries.map((c) => (
              <option key={c.country} value={c.country}>
                {c.country} ({c.companies})
              </option>
            ))}
          </select>
        ) : null}
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      <nav className="bs-chips" aria-label="Members">
        {TIERS.map((t) => (
          <Link key={t.key} href={link({ tier: t.key })} aria-current={tier === t.key ? "true" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>

      <nav className="bs-letters" aria-label="First letter">
        <Link href={link({ letter: "" })} aria-current={letter ? undefined : "true"}>
          All
        </Link>
        {LETTERS.map((l) => (
          <Link key={l} href={link({ letter: l })} aria-current={letter === l ? "true" : undefined}>
            {l}
          </Link>
        ))}
      </nav>

      {found.companies.length > 0 ? (
        <div className="bs-list">
          {found.companies.map((company) => (
            <Link key={company.id} className="bs-row" href={`/${site}/directory/${company.id}`}>
              <span className="t">
                {company.company ?? "A member company"}
                {company.premium_member ? <span className="bs-tag">Premium member</span> : null}
                {company.person || company.designation ? (
                  <span className="d">{[company.person, company.designation].filter(Boolean).join(", ")}</span>
                ) : null}
              </span>
              <span className="m">{[company.city, company.country].filter(Boolean).join(", ")}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bs-empty">No company matches that.</div>
      )}

      <Pager base={`/${site}/directory`} page={page} pages={pages} query={kept} />

      <Gate site={site} entitlement={reader.entitlement} lead="Full company details, and writing to companies through the site, are for subscribers." />
    </section>
  );
}
