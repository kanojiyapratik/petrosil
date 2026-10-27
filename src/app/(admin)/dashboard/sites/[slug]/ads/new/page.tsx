import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listPlacements } from "@/domain/dashboard/promotion";
import { AdForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New ad · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewAdPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  const slots = await listPlacements(viewer.siteIds, { site: slug });

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/ads`}>
        ← Ads
      </Link>

      <Heading title="New ad" sub={`${brand.name} · runs in its slot between its dates once saved and switched on.`} />

      <AdForm slug={slug} slots={slots} />
    </>
  );
}
