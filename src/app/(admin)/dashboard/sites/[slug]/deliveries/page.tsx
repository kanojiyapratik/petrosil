/**
 * The delivery log: every report and sample send, and for each, how many
 * mails went, failed and were opened. The old log said status 400 on every
 * row; these counts come from each mail's own outbox row.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { listSends } from "@/domain/reports/sending";
import { Chips, Empty, Heading, Pager, Panel, count, one, pageParam, when, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Delivery log · Petrosil" };
export const dynamic = "force-dynamic";

export default async function DeliveriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const kind = one(search, "kind");
  const base = `/dashboard/sites/${slug}/deliveries`;
  const paged = await listSends(viewer, slug, { kind, page: pageParam(one(search, "page")) });

  return (
    <>
      <Heading title="Delivery log" sub="Who was sent which report or sample, whether it went, and who opened it." />

      <div style={{ margin: "0 0 14px" }}>
        <Chips
          base={base}
          param="kind"
          here={{}}
          value={kind}
          options={[
            { value: "", label: "Everything" },
            { value: "report", label: "Report sends" },
            { value: "sample", label: "Samples" },
          ]}
        />
      </div>

      <Panel title={`${count(paged.total)} send${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>What</th>
              <th className="num">To</th>
              <th className="num">Sent</th>
              <th className="num">Failed</th>
              <th className="num">Opened</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`${base}/${row.id}`}>
                    <strong>{row.about ?? row.subject}</strong>
                  </Link>
                  <div className="small muted">
                    {row.kind === "sample" ? "sample" : "report"}
                    {row.sentByName ? ` · by ${row.sentByName}` : ""}
                  </div>
                </td>
                <td className="num">{count(row.recipients)}</td>
                <td className="num">{count(row.sent)}</td>
                <td className="num">{row.failed > 0 ? <strong>{count(row.failed)}</strong> : "0"}</td>
                <td className="num">{count(row.opened)}</td>
                <td>{when(row.createdAt.toISOString())}</td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>Nothing sent yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager base={base} here={{ kind }} page={paged.page} perPage={paged.per_page} total={paged.total} />
      </Panel>
    </>
  );
}
