import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { OfferForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New offer · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewOfferPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/offers`}>
        ← Offers
      </Link>

      <Heading title="New offer" sub={`${brand.name} · for someone who phoned or emailed it in. Saved as a draft unless you choose otherwise.`} />

      <OfferForm slug={slug} />
    </>
  );
}
