/**
 * The shell every one of a brand's screens sits inside.
 *
 * This is what the query parameter could never give us. While a module screen
 * was `/dashboard/articles?site=baseoil`, it was an estate screen wearing a
 * label: the brand lived in a dropdown, the filter bar offered to change it,
 * and "Clear" threw you back to all nine. Pinning the dropdown hid the
 * symptom; this removes the cause. The brand is in the path, so it is in the
 * layout — named once at the top, with its sections beside it, and nothing
 * below ever asks which brand you meant.
 *
 * The access check lives here rather than in each screen, for the same reason
 * the admin's own staff check lives in one layout: eighteen screens each
 * remembering to verify the slug is eighteen chances to forget. An unknown
 * brand and a brand this viewer may not see both answer `notFound`, so the
 * URL cannot be used to discover which brands exist.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { SiteTabs } from "./tabs";

export default async function SiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  return (
    <>
      <nav className="crumbs" aria-label="Where you are">
        <Link href="/dashboard">Overview</Link>
        <span aria-hidden="true">/</span>
        <strong>{brand.name}</strong>
      </nav>

      <SiteTabs slug={slug} name={brand.name} />

      {children}
    </>
  );
}
