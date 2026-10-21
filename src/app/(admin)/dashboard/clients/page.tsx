/**
 * The client directory.
 *
 * One row per person, not per subscription: somebody who reads three of the
 * brands is one client here, which is the thing nine separate admins could
 * never show. The segment is computed from their memberships and today's
 * date, so "expired" means expired, not "flagged expired by a cron job that
 * may not have run".
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listClients, segmentCounts, type Segment } from "@/domain/dashboard/clients";
import {
  BrandField,
  Chips,
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

export const metadata = { title: "Directory · Petrosil" };
export const dynamic = "force-dynamic";

const SEGMENTS: Segment[] = ["premium", "trial", "expired", "free"];

const TONE: Record<string, string> = {
  premium: "ok",
  trial: "warn",
  expired: "bad",
  free: "",
  staff: "brand",
};

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const q = one(search, "q");
  const segmentRaw = one(search, "segment");
  const segment = SEGMENTS.includes(segmentRaw as Segment) ? (segmentRaw as Segment) : undefined;
  const page = pageParam(one(search, "page"));

  const [brands, counts, clients] = await Promise.all([
    brandsFor(viewer.siteIds),
    segmentCounts(viewer.siteIds),
    listClients(viewer.siteIds, { site, search: q, segment, page }),
  ]);

  return (
    <>
      <Heading
        title="Directory"
        sub="Everyone registered across the estate. One person, one row, however many brands they read."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/clients">
          <BrandField brands={brands} value={site} />
          <div className="field grow">
            <label htmlFor="q">Search</label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q ?? ""}
              placeholder="Name, email or company"
            />
          </div>
          {segment ? <input type="hidden" name="segment" value={segment} /> : null}
        </Filters>
      </Panel>

      <div style={{ margin: "14px 0" }}>
        <Chips
          base="/dashboard/clients"
          param="segment"
          here={{ site, q }}
          value={segment}
          options={[
            { value: "", label: "Everyone" },
            ...SEGMENTS.map((value) => ({ value, label: value, n: counts[value] })),
          ]}
        />
      </div>

      <Panel title={`${count(clients.total)} ${clients.total === 1 ? "person" : "people"}`}>
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Company</th>
              <th>Reads</th>
              <th>Standing</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {clients.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/clients/${row.id}`}>
                    <strong>{row.name}</strong>
                  </Link>
                  <div className="small muted">{row.email}</div>
                </td>
                <td>
                  {row.company ?? <span className="muted">—</span>}
                  {row.country ? <div className="small muted">{row.country}</div> : null}
                </td>
                <td>
                  {row.brands.length === 0 ? (
                    <span className="muted">nothing</span>
                  ) : (
                    row.brands.map((brand) => (
                      <span key={brand.slug} className="tag" style={{ marginRight: 4 }}>
                        {brand.slug}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <span className={`badge ${TONE[row.segment] ?? ""}`}>{row.segment}</span>
                  {row.brands.find((brand) => brand.expires_at) ? (
                    <div className="small muted">
                      to {row.brands.map((brand) => brand.expires_at).filter(Boolean).sort().at(-1)}
                    </div>
                  ) : null}
                </td>
                <td>
                  {row.last_login_at ? when(row.last_login_at) : <span className="muted">never</span>}
                  <div className="small muted">joined {row.member_since}</div>
                </td>
              </tr>
            ))}
            {clients.rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>Nobody matches that.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base="/dashboard/clients"
          here={{ site, q, segment }}
          page={clients.page}
          perPage={clients.per_page}
          total={clients.total}
        />
      </Panel>
    </>
  );
}
