/** Import and export figures: one spreadsheet per period, listed for everyone, opened by subscribers. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { publishedSheets } from "@/domain/public/impex";
import { liveBrandBySlug } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { Pager, day, pageParam } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import & export data" };

const PER_PAGE = 30;

export default async function Impex({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const query = await searchParams;
  const q = String(query.q ?? "").trim().slice(0, 80);
  const page = pageParam(query.page);
  const found = await publishedSheets(brand.id, { search: q || undefined, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
  const pages = Math.ceil(found.total / PER_PAGE);

  return (
    <section>
      <div className="bs-head">
        <h1>Import &amp; export data</h1>
        <span className="muted num">{found.total.toLocaleString("en-US")} sheets</span>
      </div>

      <form className="bs-search" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search by country, product or month…" aria-label="Search import and export data" />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      {found.sheets.length > 0 ? (
        <div className="bs-list">
          {found.sheets.map((sheet) => (
            <Link key={sheet.slug} className="bs-row" href={`/${site}/impex/${sheet.slug}`}>
              <span className="t">
                {sheet.title}
                {sheet.description ? <span className="d">{plainText(sheet.description, 140)}</span> : null}
              </span>
              {sheet.premium ? <span className="bs-tag">Subscribers</span> : null}
              <time dateTime={sheet.authored_on ?? undefined}>{day(sheet.authored_on)}</time>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bs-empty">{q ? `No sheet matches “${q}”.` : "No import or export data here yet."}</div>
      )}

      <Pager base={`/${site}/impex`} page={page} pages={pages} query={q ? { q } : {}} />
    </section>
  );
}
