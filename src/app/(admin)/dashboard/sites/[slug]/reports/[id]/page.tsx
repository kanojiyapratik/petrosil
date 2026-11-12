import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { reportForEdit, reportTypes } from "@/domain/reports/editor";
import { ReportForm } from "../form";
import { deleteReportAction } from "../actions";
import { ConfirmDelete } from "@/app/(admin)/content-tools";
import { authorsFor } from "@/domain/content/articles";
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
  const search = await searchParams;
  const justMade = one(search, "saved") === "1";
  const refused = one(search, "refused");

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/reports`}>
        ← Reports
      </Link>

      <Heading title={report.title} sub={`${report.site_name} · last edited ${when(report.updated_at)}`}>
        {report.status !== "draft" ? (
          <a className="button small ghost" href={`/${slug}/reports/${encodeURIComponent(report.slug)}`} target="_blank" rel="noreferrer">
            View on site ↗
          </a>
        ) : null}
        {report.file_id ? (
          <Link className="button small" href={`/dashboard/sites/${slug}/reports/${report.id}/send`}>
            Send to paying readers
          </Link>
        ) : null}
      </Heading>

      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      {justMade ? (
        <p className="flash" role="status">
          Report created.
        </p>
      ) : null}

      <ReportForm slug={slug} types={await reportTypes(brand.id)} report={report} authors={await authorsFor(report.author_id)} />

      <ConfirmDelete action={deleteReportAction} id={report.id} site={slug} noun="report" list="Reports" />
    </>
  );
}
