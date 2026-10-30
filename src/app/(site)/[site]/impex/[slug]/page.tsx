/** One import/export sheet: its description for everyone, the spreadsheet for subscribers. */

import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { publishedSheet } from "@/domain/public/impex";
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

  return publishedSheet(brand.id, decodeURIComponent(slug), reader.entitlement);
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, slug } = await params;
  const sheet = await load(site, slug);

  return sheet ? { title: sheet.title, description: plainText(sheet.description, 160) || undefined } : {};
}

export default async function Sheet({ params }: Props) {
  const { site, slug } = await params;
  const sheet = await load(site, slug);

  if (!sheet) {
    notFound();
  }

  return (
    <article className="bs-card">
      <Link className="bs-crumb" href={`/${site}/impex`}>
        ← Import &amp; export data
      </Link>
      <h1 style={{ fontSize: "clamp(24px, 3.4vw, 32px)", maxWidth: "30ch" }}>{sheet.title}</h1>
      <div className="bs-byline">
        <time dateTime={sheet.authored_on ?? undefined}>{day(sheet.authored_on)}</time>
        {sheet.premium ? <span className="bs-tag">Subscribers</span> : null}
      </div>
      {sheet.description ? <div className="bs-prose" dangerouslySetInnerHTML={{ __html: cleanHtml(sheet.description) }} /> : null}
      <div className="bs-docact">
        <Download site={site} download={sheet.download} back={`/${site}/impex/${sheet.slug}`} what="Download the spreadsheet" />
      </div>
    </article>
  );
}
