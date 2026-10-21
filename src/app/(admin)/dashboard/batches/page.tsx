/**
 * Price update — every staged and committed batch, across every brand.
 *
 * The nine PHP admins each showed their own; this shows the estate, which is
 * the only way to answer "did Friday's update actually land everywhere?".
 * `needs attention` is the count that matters: rows the matcher could not
 * place, which are exactly the rows that become a client's mismatch email.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listBatches } from "@/domain/dashboard/batches";
import { BATCH_SOURCES, BATCH_STATUSES, type BatchSource, type BatchStatus } from "@/db/schema";
import {
  BrandField,
  Empty,
  Filters,
  Heading,
  Pager,
  Panel,
  count,
  one,
  pageParam,
  when,
  type Search,
} from "../../ui";

export const metadata = { title: "Price update · Petrosil" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  committed: "ok",
  draft: "warn",
  rolled_back: "bad",
  discarded: "",
};

export default async function BatchesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const statusRaw = one(search, "status");
  const sourceRaw = one(search, "source");
  const page = pageParam(one(search, "page"));

  const status = BATCH_STATUSES.includes(statusRaw as BatchStatus)
    ? (statusRaw as BatchStatus)
    : undefined;
  const source = BATCH_SOURCES.includes(sourceRaw as BatchSource)
    ? (sourceRaw as BatchSource)
    : undefined;

  const [brands, batches] = await Promise.all([
    brandsFor(viewer.siteIds),
    listBatches(viewer.siteIds, { site, status, source, page }),
  ]);

  return (
    <>
      <Heading
        title="Price update"
        sub="Each batch is one round of prices — staged, checked, then committed in a single step."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/batches">
          <BrandField brands={brands} value={site} />
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status ?? ""}>
              <option value="">Any status</option>
              {BATCH_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="source">Came from</label>
            <select id="source" name="source" defaultValue={source ?? ""}>
              <option value="">Any source</option>
              {BATCH_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {value.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </Filters>
      </Panel>

      <Panel title={`${count(batches.total)} batch${batches.total === 1 ? "" : "es"}`}>
        <table>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Brand</th>
              <th>Status</th>
              <th className="num">Rows</th>
              <th className="num">Needs attention</th>
              <th>Staged</th>
              <th>Committed</th>
            </tr>
          </thead>
          <tbody>
            {batches.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/batches/${row.id}`}>
                    <strong>#{row.id}</strong>
                  </Link>
                  <div className="small muted">{row.source.replace("_", " ")}</div>
                </td>
                <td>{row.site_name}</td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>
                    {row.status.replace("_", " ")}
                  </span>
                </td>
                <td className="num">{count(row.items)}</td>
                <td className="num">
                  {row.needs_attention > 0 ? (
                    <span className="badge bad">{count(row.needs_attention)}</span>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </td>
                <td>
                  {when(row.created_at)}
                  <div className="small muted">{row.created_by ?? "unknown"}</div>
                </td>
                <td>
                  {row.committed_at ? (
                    <>
                      {when(row.committed_at)}
                      <div className="small muted">{row.committed_by ?? "unknown"}</div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            {batches.rows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <Empty>No batches match those filters.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base="/dashboard/batches"
          here={{ site, status, source }}
          page={batches.page}
          perPage={batches.per_page}
          total={batches.total}
        />
      </Panel>
    </>
  );
}
