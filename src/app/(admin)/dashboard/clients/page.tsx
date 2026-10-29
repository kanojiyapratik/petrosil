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
import { EXPORT_SEGMENTS } from "@/domain/clients/export";
import {
  Chips,
  Empty,
  Heading,
  Pager,
  Panel,
  count,
  one,
  pageParam,
  when,
  type Search,
  BrandChips,
  ListBar,
} from "../../ui";
import { Popup } from "@/app/(admin)/popup";
import { PeopleNav } from "@/app/(admin)/people-nav";

export const metadata = { title: "Directory · Petrosil" };
export const dynamic = "force-dynamic";

const SEGMENTS: Segment[] = ["premium", "trial", "expired", "trial_expired", "free"];

/** The old admin's own words for these lists. */
const SEGMENT_LABEL: Record<string, string> = {
  premium: "premium",
  trial: "on trial",
  expired: "expired premium",
  trial_expired: "expired trial",
  free: "free",
  staff: "staff",
};

/** A chip reads as a label, so it starts with a capital; the badges in the table stay lower case. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const TONE: Record<string, string> = {
  premium: "ok",
  trial: "warn",
  expired: "bad",
  trial_expired: "bad",
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
  // "Upcoming Renewal" in the rail is this: paying, due inside 30 days.
  const dueRaw = Number(one(search, "due"));
  const due = Number.isFinite(dueRaw) && dueRaw > 0 ? Math.trunc(dueRaw) : undefined;

  const [brands, counts, clients] = await Promise.all([
    brandsFor(viewer.siteIds),
    segmentCounts(viewer.siteIds),
    listClients(viewer.siteIds, { site, search: q, segment, due, page }),
  ]);

  return (
    <>
      <PeopleNav />

      <Heading
        title="Customers"
        sub={
          due
            ? `Paying members whose subscription runs out within ${due} days.`
            : "The old admin's Directory: everyone registered across the estate. One person, one row, however many brands they read."
        }
      >
        <Popup label="Download a list" title="Download a list">
          <form action="/api/dashboard/exports/people" method="get" className="bar">
            <div className="field">
              <label htmlFor="export-site">Brand</label>
              <select id="export-site" name="site" defaultValue={site ?? brands[0]?.slug ?? ""} required>
                {brands.map((brand) => (
                  <option key={brand.slug} value={brand.slug}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="export-segment">List</label>
              <select id="export-segment" name="segment" defaultValue={segment ?? "all"}>
                {EXPORT_SEGMENTS.map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit">Download CSV</button>
          </form>
          <p className="small muted" style={{ margin: ".4rem 0 0" }}>
            Readers only: staff and closed accounts are left out. Standing is worked out from today&apos;s date on that
            brand, so a lapsed subscription is in Expired premium even if nobody has touched it.
          </p>
        </Popup>
      </Heading>

      <BrandChips base="/dashboard/clients" brands={brands} value={site} here={{ q, segment }} />

      <ListBar action="/dashboard/clients" q={q} placeholder="Search: name, email or company" keep={{ site, segment }}>
        <Chips
          base="/dashboard/clients"
          param="segment"
          here={{ site, q }}
          value={segment}
          options={[
            { value: "", label: "Everyone" },
            ...SEGMENTS.map((value) => ({
              value,
              label: sentence(SEGMENT_LABEL[value] ?? value),
              n: counts[value],
            })),
          ]}
        />
      </ListBar>

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
                  <span className={`badge ${TONE[row.segment] ?? ""}`}>
                    {SEGMENT_LABEL[row.segment] ?? row.segment}
                  </span>
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
          here={{ site, q, segment, due: due ? String(due) : undefined }}
          page={clients.page}
          perPage={clients.per_page}
          total={clients.total}
        />
      </Panel>

    </>
  );
}
