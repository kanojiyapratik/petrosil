/**
 * General settings for one brand.
 *
 * Each field shows the brand's own value or, where it has none, the estate's
 * default it follows. The defaults themselves are under Global settings →
 * Site defaults; this tab never edits another brand or the estate. The old
 * arrangement was 69 rows per site, nine times over, with no defaults and
 * therefore no way to change one thing everywhere.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { settingsFor } from "@/domain/dashboard/settings";
import { SettingsForm } from "./form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "Settings · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  const [brands, rows] = await Promise.all([brandsFor(viewer.siteIds), settingsFor(viewer.siteIds, { site: slug })]);
  const brand = brands.find((row) => row.slug === slug)!;

  return (
    <>
      <Heading
        title="General"
        sub={`${brand.name}'s own settings. A field marked "from the estate" follows the site defaults until you set a value here.`}
      >
        {viewer.isSuperadmin ? (
          <Link className="button ghost small" href="/dashboard/global/settings">
            Site defaults
          </Link>
        ) : null}
      </Heading>

      <SettingsForm rows={rows.filter((row) => row.group !== "Mail")} site={slug} canEdit />
    </>
  );
}
