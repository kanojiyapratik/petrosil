/**
 * Sample reports: the free reports a brand offers prospects.
 *
 * A sample is a report of kind "sample", written and edited in the report
 * editor like any other. The old sites kept them in a separate table, and
 * all nine held the same one row — "Bitumart Sample Report - June 16, 2020",
 * naming a 1.pdf that none of them had — a leftover from the first site's
 * setup, so nothing was carried. Send a sample (Emailer) mails any of the
 * brand's reports, these included, to one prospect.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listReports } from "@/domain/dashboard/publishing";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";

export const metadata = { title: "Sample reports · Petrosil" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { published: "ok", premium: "brand", draft: "warn" };

export default async function SampleReportsPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  if (!(await brandsFor(viewer.siteIds)).some((brand) => brand.slug === slug)) {
    notFound();
  }

  const samples = await listReports(viewer.siteIds, { site: slug, type: "sample", perPage: 100 });

  return (
    <>
      <Heading title="Sample reports" sub="Free reports a prospect can read before they subscribe.">
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/send-sample`}>
          Send a sample
        </Link>
        <Link className="button small" href={`/dashboard/sites/${slug}/reports/new?kind=sample`}>
          New sample report
        </Link>
      </Heading>

      <Panel title={`${count(samples.total)} sample report${samples.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Title</th>
              <th>Dated</th>
              <th>Who can read it</th>
              <th className="num">Opened</th>
            </tr>
          </thead>
          <tbody>
            {samples.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/reports/${row.id}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  <div className="small muted">{row.file ? <code>{row.file}</code> : "no file attached"}</div>
                </td>
                <td>{row.authored_on ?? <span className="muted">undated</span>}</td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>
                    {row.status === "premium" ? "subscribers" : row.status === "published" ? "everyone" : row.status}
                  </span>
                </td>
                <td className="num">{count(row.clicks)}</td>
              </tr>
            ))}
            {samples.rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>
                    No sample reports yet. The old sites each held the same placeholder row with no file, so nothing was
                    carried; add one here.
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <p className="small muted">
        A sample is a report of kind &quot;sample&quot;: it is edited in the report editor, and set to &quot;Open to
        everyone&quot; for prospects to read it.
      </p>
    </>
  );
}
