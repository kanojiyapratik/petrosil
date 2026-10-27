import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { reportTypes } from "@/domain/reports/editor";
import { ReportForm } from "../form";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "New report · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);

  if (!brand) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/reports`}>
        ← Reports
      </Link>

      <Heading
        title="New report"
        sub={`${brand.name} · saved as a draft unless you choose otherwise. Upload the PDF here; it goes into this brand's report files.`}
      />

      <ReportForm slug={slug} types={await reportTypes(brand.id)} />
    </>
  );
}
