/** Send one report, with its PDF attached, to the brand's paying readers. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { reportSendForm } from "@/domain/reports/sending";
import { fileStore } from "@/lib/files/store";
import { SendReportForm } from "./form";
import { Heading, Panel } from "@/app/(admin)/ui";

export const metadata = { title: "Send a report · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SendReportPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const form = await reportSendForm(viewer, slug, Number(id), fileStore());

  if (!form) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/reports`}>
        ← Reports
      </Link>

      <Heading title={`Send “${form.report.title}”`} sub="To every current paying reader, with the PDF attached." />

      {form.hasPdf ? (
        <Panel title="Who, and what it says" flush={false}>
          <SendReportForm
            site={slug}
            reportId={form.report.id}
            subject={form.subject}
            body={form.body}
            readers={form.readers}
            extra={form.extra}
          />
        </Panel>
      ) : (
        <Panel title="Nothing to send" flush={false}>
          <p>
            This report&apos;s PDF ({form.report.file ? <code>{form.report.file}</code> : "none named"}) is not in the file
            store. Upload it under <code>reports/files</code> on the Files screen first.
          </p>
        </Panel>
      )}
    </>
  );
}
