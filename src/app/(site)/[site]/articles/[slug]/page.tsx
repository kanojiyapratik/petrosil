/** One article. A subscribers-only one shows its opening to everyone and the rest to readers who pay. */

import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { publishedArticle } from "@/domain/content/articles";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { cleanHtml, plainText } from "@/lib/public/html";
import { Gate, day } from "../../ui";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ site: string; slug: string }> };

// Once per request: reading an article counts a view, and the metadata and
// the page both need it.
const load = cache(async (site: string, slug: string) => {
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    return null;
  }

  const reader = await readerFor(brand.id);
  const found = await publishedArticle(brand.id, decodeURIComponent(slug), reader.entitlement.entitled);

  return found ? { brand, reader, ...found } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, slug } = await params;
  const found = await load(site, slug);

  return found ? { title: found.article.title, description: plainText(found.article.excerpt, 160) || undefined } : {};
}

export default async function Article({ params }: Props) {
  const { site, slug } = await params;
  const found = await load(site, slug);

  if (!found) {
    notFound();
  }

  const { article, locked, reader } = found;

  return (
    <article className="bs-card">
      <Link className="bs-crumb" href={`/${site}/articles`}>
        ← Articles
      </Link>
      <h1 style={{ fontSize: "clamp(24px, 3.4vw, 34px)", maxWidth: "28ch" }}>{article.title}</h1>
      <div className="bs-byline">
        {article.category ? <span className="eyebrow">{article.category.replace(/-/g, " ")}</span> : null}
        <time dateTime={article.published_at ?? undefined}>{day(article.published_at)}</time>
        {article.premium_only ? <span className="bs-tag">Subscribers</span> : null}
      </div>

      {locked ? (
        <>
          {article.excerpt ? (
            <div className="bs-prose">
              <p>{plainText(article.excerpt, 600)}</p>
            </div>
          ) : null}
          <Gate site={site} entitlement={reader.entitlement} what="full articles" />
        </>
      ) : (
        <div className="bs-prose" dangerouslySetInnerHTML={{ __html: cleanHtml(article.body ?? article.excerpt) }} />
      )}
    </article>
  );
}
