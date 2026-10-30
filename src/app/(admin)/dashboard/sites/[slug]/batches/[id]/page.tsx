/**
 * One batch, row by row.
 *
 * The statuses are the point. `changed` and `new` will publish; `unmatched`
 * and `ambiguous` will not, and are the rows somebody has to look at. They
 * are listed first for that reason — a 400-row upload with four problems
 * should not make you scroll to find them.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { batchDetail } from "@/domain/dashboard/batches";
import { Change, Empty, Heading, Panel, count, money, one, when, type Search } from "@/app/(admin)/ui";
import { Publish } from "./publish";
import { RollBack } from "./rollback";

export const dynamic = "force-dynamic";

const NEEDS_LOOK = new Set(["ambiguous", "unmatched", "invalid", "conflict", "locked"]);

const TONE: Record<string, string> = {
  new: "ok",
  changed: "ok",
  unchanged: "",
  locked: "warn",
  ambiguous: "bad",
  unmatched: "bad",
  invalid: "bad",
  conflict: "bad",
};

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const search = await searchParams;

  const batch = await batchDetail(viewer.siteIds, Number(id));

  if (!batch) {
    notFound();
  }

  // Problems first, then the rest in the order they were staged.
  const rows = [...batch.rows].sort((a, b) => {
    const aBad = NEEDS_LOOK.has(a.status) ? 0 : 1;
    const bBad = NEEDS_LOOK.has(b.status) ? 0 : 1;

    return aBad - bBad || a.id - b.id;
  });

  const tally = new Map<string, number>();

  for (const row of batch.rows) {
    tally.set(row.status, (tally.get(row.status) ?? 0) + 1);
  }

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/batches`}>
        ← Price update
      </Link>

      <Heading
        title={`Batch #${batch.id}`}
        sub={`${batch.site_name} · ${batch.source.replace("_", " ")} · staged ${when(batch.created_at)} by ${batch.created_by ?? "unknown"}`}
      >
        <span className={`badge ${batch.status === "committed" ? "ok" : batch.status === "draft" ? "warn" : "bad"}`}>
          {batch.status.replace("_", " ")}
        </span>
        {batch.status === "draft" ? (
          <Publish slug={slug} batch={batch.id} rows={batch.rows.filter((row) => row.is_included && (row.status === "new" || row.status === "changed")).length} />
        ) : null}
        {batch.status === "committed" ? (
          <RollBack slug={slug} batch={batch.id} rows={batch.rows.filter((row) => row.is_included && (row.status === "new" || row.status === "changed")).length} />
        ) : null}
      </Heading>

      {one(search, "done") ? (
        <p className="flash" role="status">
          {one(search, "done")}
        </p>
      ) : null}

      {one(search, "saved") ? (
        <p className="flash" role="status">
          Saved {one(search, "saved")} price{one(search, "saved") === "1" ? "" : "s"}
          {one(search, "draft") ? ` from AI draft #${one(search, "draft")}` : ""}. Check them below, then commit to put them on the website.
        </p>
      ) : null}

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(batch.items)}</div>
          <div className="k">rows staged</div>
        </div>
        <div className="tile">
          <div className="n">{count(batch.needs_attention)}</div>
          <div className="k">need attention</div>
        </div>
        <div className="tile">
          <div className="n">{count(batch.rows.filter((row) => row.is_included).length)}</div>
          <div className="k">included</div>
        </div>
        <div className="tile">
          <div className="n">{batch.committed_at ? when(batch.committed_at).split(",")[0] : "—"}</div>
          <div className="k">{batch.committed_by ? `committed by ${batch.committed_by}` : "not committed"}</div>
        </div>
      </div>

      <Panel flush={false} title="How the rows resolved">
        <div className="chips">
          {[...tally.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([status, n]) => (
              <span key={status} className="chip">
                {status.replace("_", " ")} <b>{count(n)}</b>
              </span>
            ))}
        </div>
      </Panel>

      <Panel title="Rows" hint="Rows needing a look are listed first.">
        <table className="tight">
          <thead>
            <tr>
              <th>Location</th>
              <th>Date</th>
              <th>Was</th>
              <th>Becomes</th>
              <th>Change</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pct =
                row.old_price !== null && row.old_price !== 0
                  ? Math.round(((row.new_price - row.old_price) / row.old_price) * 10000) / 100
                  : null;

              return (
                <tr key={row.id}>
                  <td>
                    {row.location ? (
                      <strong>{row.location}</strong>
                    ) : (
                      <span className="muted">unmatched</span>
                    )}
                    <div className="small muted">as written: {row.raw_location}</div>
                  </td>
                  <td>{row.price_date}</td>
                  <td>{money(row.old_price, row.currency)}</td>
                  <td>
                    <strong>{money(row.new_price, row.currency)}</strong>
                  </td>
                  <td>
                    <Change pct={pct} />
                  </td>
                  <td>
                    <span className={`badge ${TONE[row.status] ?? ""}`}>{row.status}</span>
                    {row.error_message ? (
                      <div className="small muted">{row.error_message}</div>
                    ) : null}
                    {!row.is_included ? <div className="small muted">excluded</div> : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>This batch has no rows.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
