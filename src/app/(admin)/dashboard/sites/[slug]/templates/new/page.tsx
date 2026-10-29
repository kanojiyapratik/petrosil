import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { TemplateForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New newsletter template · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewTemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/templates`}>
        ← Newsletter templates
      </Link>

      <Heading title="New newsletter template" sub={`${brand.name} · offered when composing an issue once saved.`} />

      <TemplateForm slug={slug} />
    </>
  );
}
