/**
 * One batch, row by row.
 *
 * The statuses are the point. `changed` and `new` will publish; `unmatched`
 * and `ambiguous` will not, and are the rows somebody has to look at. They
 * are listed first for that reason — a 400-row upload with four problems
 * should not make you scroll to find them.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { batchDetail } from "@/domain/dashboard/batches";
import { Change, Empty, Heading, Panel, count, money, one, when, type Search } from "@/app/(admin)/ui";
import { can } from "@/domain/staff/permissions";
import { marketsToPick } from "@/domain/price/upload";
import { Publish } from "./publish";
import { RollBack } from "./rollback";
import { RowEdit } from "./row-edit";
import { RunReview } from "./review";
import { reviewOf } from "@/domain/price/review";

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

  // Rows are mended only on a draft, by someone who may stage updates.
  const editing = batch.status === "draft" && (await can(viewer, batch.site_id, "price-batch-create"));
  const markets = editing && batch.rows.some((row) => row.status === "unmatched" || row.status === "ambiguous") ? await marketsToPick(batch.site_id) : [];

  const review = await reviewOf(batch.id);
  const mayReview = batch.status === "draft" && (await can(viewer, batch.site_id, "price-batch-view"));

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

      {mayReview || review ? (
        <div id="review">
          <Panel
            title="AI review"
            flush={false}
            hint={review ? `${when(review.at)}${review.by ? ` · ${review.by}` : ""}${review.model ? ` · ${review.model}` : ""}` : undefined}
            aside={mayReview ? <RunReview slug={slug} batch={batch.id} again={review !== null} /> : null}
          >
            {!review ? (
              <p className="muted" style={{ margin: 0 }}>
                Before committing, the AI can read this batch as it stands and say whether anything looks wrong: an
                implausible jump, a zero, a market far out of line. It changes nothing.
              </p>
            ) : (
              <>
                {review.stale ? (
                  <p className="flash" role="status" style={{ marginTop: 0 }}>
                    Rows were changed after this review. Run it again to review the batch as it is now.
                  </p>
                ) : null}
                {review.text ? (
                  <p style={{ whiteSpace: "pre-line", maxWidth: "80ch", marginTop: 0 }}>
                    {/* The model is asked for prose but may still use **bold** or a # heading. */}
                    {review.text
                      .replace(/^#{1,6}\s+/gm, "")
                      .split(/\*\*(.+?)\*\*/g)
                      .map((part, at) => (at % 2 === 1 ? <strong key={at}>{part}</strong> : part))}
                  </p>
                ) : (
                  <p className={review.status === "skipped" ? "muted" : "bad"} style={{ marginTop: 0 }}>
                    {review.status === "skipped"
                      ? review.error
                      : review.status === "declined"
                        ? `The model declined to review this batch.${review.error ? ` Reason: ${review.error}` : ""} You can run it again.`
                        : `The review did not complete: ${review.error ?? "no reason was given"}.`}
                  </p>
                )}
                {review.suspected.length > 0 ? (
                  <>
                    <h3 className="small muted" style={{ margin: "12px 0 4px" }}>
                      Rows the figures flag
                    </h3>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {review.suspected.map((row) => (
                        <li key={row.location}>
                          <strong>{row.location}</strong>: {row.old_price ?? "—"} → {row.new_price ?? "—"}{" "}
                          <span className="muted">({row.reason})</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </Panel>
        </div>
      ) : null}

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
              {editing ? <th aria-label="Edit" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              // A price on a date that had none moves from the last one published.
              const from = row.old_price ?? row.previous_price;
              const pct = from !== null && from !== 0 ? Math.round(((row.new_price - from) / from) * 10000) / 100 : null;

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
                  <td>
                    {row.old_price !== null ? (
                      money(row.old_price, row.currency)
                    ) : row.previous_price !== null ? (
                      <>
                        {money(row.previous_price, row.currency)}
                        <div className="small muted">last published</div>
                      </>
                    ) : (
                      money(null, row.currency)
                    )}
                  </td>
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
                  {editing ? (
                    <td>
                      <RowEdit
                        slug={slug}
                        batch={batch.id}
                        row={row}
                        markets={row.status === "unmatched" || row.status === "ambiguous" ? markets : undefined}
                      />
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={editing ? 7 : 6}>
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
