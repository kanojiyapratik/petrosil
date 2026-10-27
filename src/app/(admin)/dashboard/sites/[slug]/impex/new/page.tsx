import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { ImpexForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New impex sheet · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewImpexPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/impex`}>
        ← Trade data
      </Link>

      <Heading title="New impex sheet" sub={`${brand.name} · saved as a draft unless you choose otherwise.`} />

      <ImpexForm slug={slug} />
    </>
  );
}
