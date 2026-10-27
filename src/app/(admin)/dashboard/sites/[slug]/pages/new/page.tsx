import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { PageForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New page · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewPagePage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/pages`}>
        ← Pages
      </Link>

      <Heading title="New page" sub={`${brand.name} · shown on the site as soon as it is saved, unless you untick Shown.`} />

      <PageForm slug={slug} />
    </>
  );
}
