/** One report: what it covers for everyone, the download for those who may have it. */

import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { publishedReport } from "@/domain/public/reports";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { cleanHtml, plainText } from "@/lib/public/html";
import { Download, day } from "../../ui";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ site: string; slug: string }> };

const load = cache(async (site: string, slug: string) => {
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    return null;
  }

  const reader = await readerFor(brand.id);

  return publishedReport(brand.id, decodeURIComponent(slug), reader.entitlement);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, slug } = await params;
  const report = await load(site, slug);

  return report
    ? {
        title: report.meta_title || report.title,
        description: plainText(report.meta_description || report.description, 160) || undefined,
      }
    : {};
}

export default async function Report({ params }: Props) {
  const { site, slug } = await params;
  const report = await load(site, slug);

  if (!report) {
    notFound();
  }

  return (
    <article className="bs-card bs-docpage">
      <Link className="bs-crumb" href={`/${site}/reports`}>
        ← Reports
      </Link>
      <div className="bs-docbody">
        {report.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="bs-cover" src={report.thumbnail_url} alt="" />
        ) : null}
        <div>
          <h1 style={{ fontSize: "clamp(24px, 3.4vw, 32px)", maxWidth: "30ch" }}>{report.title}</h1>
          <div className="bs-byline">
            <time dateTime={report.authored_on ?? undefined}>{day(report.authored_on)}</time>
            {report.premium ? <span className="bs-tag">Subscribers</span> : null}
          </div>
          {report.description ? <div className="bs-prose" dangerouslySetInnerHTML={{ __html: cleanHtml(report.description) }} /> : null}
          <div className="bs-docact">
            <Download site={site} download={report.download} back={`/${site}/reports/${report.slug}`} what="Download the report (PDF)" />
          </div>
        </div>
      </div>
    </article>
  );
}
