import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { reportForEdit, reportTypes } from "@/domain/reports/editor";
import { ReportForm, WithdrawReport } from "../form";
import { Heading, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const report = await reportForEdit(viewer.siteIds, Number(id));

  // Another brand's report, reached through this brand's address, is not found here.
  if (!report || report.site !== slug) {
    notFound();
  }

  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug)!;
  const justMade = one(await searchParams, "saved") === "1";

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/reports`}>
        ← Reports
      </Link>

      <Heading title={report.title} sub={`${report.site_name} · last edited ${when(report.updated_at)}`}>
        {report.file_id ? (
          <Link className="button small" href={`/dashboard/sites/${slug}/reports/${report.id}/send`}>
            Send to paying readers
          </Link>
        ) : null}
      </Heading>

      {justMade ? (
        <p className="flash" role="status">
          Report created.
        </p>
      ) : null}

      <ReportForm slug={slug} types={await reportTypes(brand.id)} report={report} />

      <WithdrawReport slug={slug} id={report.id} />
    </>
  );
}
