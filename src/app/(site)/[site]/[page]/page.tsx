/**
 * The brand's own pages — About us, Methodology, the policies — by the slug
 * staff gave them. Any path that is not a section and not a page is a 404.
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { pageBySlug } from "@/domain/content/pages";
import { liveBrandBySlug } from "@/lib/public/reader";
import { cleanHtml } from "@/lib/public/html";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ site: string; page: string }> };

async function load({ params }: Props) {
  const { site, page } = await params;
  const brand = await liveBrandBySlug(site);

  return brand ? pageBySlug(brand.id, decodeURIComponent(page)) : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const page = await load(props);

  return page ? { title: page.title } : {};
}

export default async function BrandPage(props: Props) {
  const page = await load(props);

  if (!page) {
    notFound();
  }

  return (
    <article className="bs-card">
      <h1 style={{ fontSize: "clamp(24px, 3.4vw, 32px)", marginBottom: 16 }}>{page.title}</h1>
      <div className="bs-prose" dangerouslySetInnerHTML={{ __html: cleanHtml(page.body) }} />
    </article>
  );
}
