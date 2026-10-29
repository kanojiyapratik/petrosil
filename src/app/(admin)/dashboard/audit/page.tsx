/**
 * The audit trail.
 *
 * Every change the admin and the API make lands here with who made it, from
 * where, and what it was. `by token` marks the price module acting on its
 * own behalf, which is how a figure that nobody remembers entering gets
 * explained.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { auditTrail } from "@/domain/dashboard/activity";
import {
  BrandChips,
  ListBar,
  Empty,
  Heading,
  Panel,
  count,
  one,
  when,
  type Search,
} from "../../ui";

export const metadata = { title: "Activity · Petrosil" };
export const dynamic = "force-dynamic";

/** A detail blob as one readable line, longest values last. */
function summarise(detail: Record<string, unknown> | null): string | null {
  if (!detail) {
    return null;
  }

  const parts = Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);

  if (parts.length === 0) {
    return null;
  }

  return parts.sort((a, b) => a.length - b.length).join(" · ");
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const action = one(search, "action");

  const [brands, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    auditTrail(viewer.siteIds, { site, action, limit: 200 }),
  ]);

  return (
    <>
      <Heading
        title="Activity"
        sub="Who changed what, and from where. Nothing here can be edited, including by a superadmin."
      />

      <BrandChips base="/dashboard/audit" brands={brands} value={site} here={{ action }} />
      <ListBar action="/dashboard/audit" q={action} name="action" placeholder="Search: action, e.g. price.commit" keep={{ site }} />

      <Panel title={`${count(rows.length)} entr${rows.length === 1 ? "y" : "ies"}`} hint="Newest first, 200 shown.">
        <table className="tight">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Brand</th>
              <th>Action</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const detail = summarise(row.detail);

              return (
                <tr key={row.id}>
                  <td>{when(row.at)}</td>
                  <td>
                    {row.who ?? <span className="muted">—</span>}
                    {row.by_token ? <div className="small muted">via API token</div> : null}
                    {row.ip ? <div className="small muted">{row.ip}</div> : null}
                  </td>
                  <td>{row.site ?? <span className="muted">estate</span>}</td>
                  <td>
                    <code>{row.action}</code>
                  </td>
                  <td>
                    {row.entity ? (
                      <span>
                        {row.entity}
                        {row.entity_id !== null ? ` #${row.entity_id}` : ""}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {detail ? <div className="small muted">{detail}</div> : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>Nothing recorded for those filters.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
