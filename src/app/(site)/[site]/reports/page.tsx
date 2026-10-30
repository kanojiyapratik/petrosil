/** The brand's reports, newest first. Listed for everyone; the PDF is for subscribers. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { publishedReports } from "@/domain/public/reports";
import { liveBrandBySlug } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { Pager, day, pageParam } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

const PER_PAGE = 24;

export default async function Reports({
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
  const found = await publishedReports(brand.id, { search: q || undefined, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
  const pages = Math.ceil(found.total / PER_PAGE);

  return (
    <section>
      <div className="bs-head">
        <h1>Reports</h1>
        <span className="muted num">{found.total.toLocaleString("en-US")} published</span>
      </div>

      <form className="bs-search" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search report titles…" aria-label="Search reports" />
        <button className="btn" type="submit">
          Search
        </button>
      </form>

      {found.reports.length > 0 ? (
        <div className="bs-cards">
          {found.reports.map((report) => (
            <Link key={report.slug} className="bs-art bs-doc" href={`/${site}/reports/${report.slug}`}>
              {report.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={report.thumbnail_url} alt="" loading="lazy" />
              ) : null}
              <h3>
                {report.title}
                {report.premium ? <span className="bs-tag">Subscribers</span> : null}
              </h3>
              {report.description ? <p>{plainText(report.description, 160)}</p> : null}
              <time dateTime={report.authored_on ?? undefined}>{day(report.authored_on)}</time>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bs-empty">{q ? `No report title matches “${q}”.` : "No reports here yet."}</div>
      )}

      <Pager base={`/${site}/reports`} page={page} pages={pages} query={q ? { q } : {}} />
    </section>
  );
}
