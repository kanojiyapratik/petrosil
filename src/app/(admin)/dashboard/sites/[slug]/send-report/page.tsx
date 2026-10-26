/** Choose which report to send: the brand's reports that have their PDF in the store. */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { sendableReports } from "@/domain/reports/sending";
import { fileStore } from "@/lib/files/store";
import { Empty, Heading, Panel, when } from "@/app/(admin)/ui";

export const metadata = { title: "Send a report · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SendReportIndex({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const list = await sendableReports(viewer, slug, fileStore());

  return (
    <>
      <Heading title="Send a report" sub="Pick the report; the next screen chooses who gets it and what the mail says." />

      <Panel title="Latest reports with a PDF">
        <table className="tight">
          <tbody>
            {list.map((report) => (
              <tr key={report.id}>
                <td>
                  <strong>{report.title}</strong>
                  <div className="small muted">
                    <code>{report.file}</code> · added {when(report.createdAt.toISOString())}
                  </div>
                </td>
                <td style={{ textAlign: "right" }}>
                  <Link className="button" href={`/dashboard/sites/${slug}/reports/${report.id}/send`}>
                    Send
                  </Link>
                </td>
              </tr>
            ))}
            {list.length === 0 ? (
              <tr>
                <td>
                  <Empty>No report has its PDF in the file store yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
