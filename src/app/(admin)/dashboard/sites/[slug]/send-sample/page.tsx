/**
 * Send sample reports to one reader. Find them first; then pick the reports.
 * The old screen could only send the two latest; here any of them can go.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { findReaders, sendableReports } from "@/domain/reports/sending";
import { fileStore } from "@/lib/files/store";
import { SendSampleForm } from "./form";
import { Empty, Filters, Heading, Panel, one, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Send a sample · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SendSamplePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const q = one(search, "q") ?? "";
  const chosenId = Number(one(search, "user"));
  const base = `/dashboard/sites/${slug}/send-sample`;

  const [found, reports] = await Promise.all([
    findReaders(viewer, slug, q),
    Number.isInteger(chosenId) && chosenId > 0 ? sendableReports(viewer, slug, fileStore()) : Promise.resolve([]),
  ]);
  const chosen = chosenId > 0 ? found.find((reader) => reader.userId === chosenId) : undefined;

  return (
    <>
      <Heading title="Send a sample" sub="Sample reports, as attachments, to one reader who might subscribe." />

      <Panel title="1. Who" flush={false}>
        <Filters action={base}>
          <div className="field grow">
            <label htmlFor="q">Name, company or email</label>
            <input id="q" name="q" type="search" defaultValue={q} placeholder="At least two letters" />
          </div>
        </Filters>

        {q.length >= 2 ? (
          <table className="tight" style={{ marginTop: ".75rem" }}>
            <tbody>
              {found.map((reader) => (
                <tr key={reader.userId}>
                  <td>
                    <strong>{reader.name}</strong>{" "}
                    <span className="muted small">
                      {reader.email}
                      {reader.company ? ` · ${reader.company}` : ""}
                      {reader.country ? ` · ${reader.country}` : ""}
                    </span>
                  </td>
                  <td>
                    <span className="badge">{reader.tier}</span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {chosen?.userId === reader.userId ? (
                      <strong>chosen</strong>
                    ) : (
                      <Link href={`${base}?q=${encodeURIComponent(q)}&user=${reader.userId}`}>Choose</Link>
                    )}
                  </td>
                </tr>
              ))}
              {found.length === 0 ? (
                <tr>
                  <td>
                    <Empty>No reader of this brand matches.</Empty>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </Panel>

      {chosen ? (
        <Panel title={`2. Which reports, for ${chosen.name}`} flush={false}>
          {reports.length > 0 ? (
            <SendSampleForm site={slug} userId={chosen.userId} reports={reports} />
          ) : (
            <Empty>No report has its PDF in the file store yet.</Empty>
          )}
        </Panel>
      ) : null}
    </>
  );
}
