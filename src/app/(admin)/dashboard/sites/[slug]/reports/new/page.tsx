import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { reportTypes } from "@/domain/reports/editor";
import { ReportForm } from "../form";
import { Heading, one, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "New report · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  // "?kind=sample" from the Sample reports screen starts the report as a sample.
  const kind = one(await searchParams, "kind") === "sample" ? "sample" : undefined;
  const back = kind ? `/dashboard/sites/${slug}/sample-reports` : `/dashboard/sites/${slug}/reports`;

  return (
    <>
      <Link className="crumb" href={back}>
        ← {kind ? "Sample reports" : "Reports"}
      </Link>

      <Heading
        title={kind ? "New sample report" : "New report"}
        sub={`${brand.name} · saved as a draft unless you choose otherwise. Upload the PDF here; it goes into this brand's report files.`}
      />

      <ReportForm slug={slug} types={await reportTypes(brand.id)} kind={kind} />
    </>
  );
}
