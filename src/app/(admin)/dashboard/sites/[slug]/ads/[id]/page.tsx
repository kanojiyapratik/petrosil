import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { adForEdit } from "@/domain/ads/editor";
import { listPlacements } from "@/domain/dashboard/promotion";
import { AdForm, WithdrawAd } from "../form";
import { Heading, one, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function AdPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const ad = await adForEdit(viewer.siteIds, Number(id));

  // Another brand's ad, reached through this brand's address, is not found here.
  if (!ad || ad.site !== slug) {
    notFound();
  }

  const [slots, search] = await Promise.all([listPlacements(viewer.siteIds, { site: slug }), searchParams]);

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/ads`}>
        ← Ads
      </Link>

      <Heading title={ad.title} sub={`${ad.site_name} · ${ad.starts_at ?? "from now"} to ${ad.ends_at ?? "no end date"}`} />

      {one(search, "saved") === "1" ? (
        <p className="flash" role="status">
          Ad created.
        </p>
      ) : null}

      <AdForm slug={slug} slots={slots} ad={ad} />

      <WithdrawAd slug={slug} id={ad.id} />
    </>
  );
}
