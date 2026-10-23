/**
 * A brand's dashboard — the first thing you see on entering it.
 *
 * The name, the breadcrumb and the tab strip belong to the layout, because
 * every screen under this brand wears them. This file is only the Dashboard
 * tab's own content: whether this brand's price list is current, what moved
 * most recently, and whether the price module ever ran for it.
 *
 * The nine PHP admins could not have had this screen. Each of them *was* one
 * brand, so none of them ever needed to name one.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { siteSnapshot } from "@/domain/dashboard/site";
import { listBatches } from "@/domain/dashboard/batches";
import { Empty, Panel, Tile, count, money } from "../../../ui";

export const dynamic = "force-dynamic";

const SAYS: Record<string, { label: string; tone: string }> = {
  fresh: { label: "prices up to date", tone: "ok" },
  due: { label: "update due", tone: "warn" },
  stale: { label: "overdue", tone: "bad" },
  none: { label: "no prices yet", tone: "" },
};

export default async function SitePage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  const snap = await siteSnapshot(slug, viewer.siteIds);

  // The layout has already refused an unknown or forbidden brand. This asks
  // again rather than asserting non-null, because a page that trusts its
  // layout to have checked is a page that breaks the day the layout changes.
  if (!snap) {
    notFound();
  }

  const batches = await listBatches(viewer.siteIds, { site: slug, page: 1 });
  const says = SAYS[snap.freshness]!;

  return (
    <>
      <div className="tiles">
        <Tile n={snap.markets} k="published markets" />
        <Tile n={snap.prices} k="prices held" />
        <Tile n={snap.readers} k="readers" />
        <Tile n={snap.paying} k="paying" />
        <Tile n={snap.trialling} k="on trial" />
        <Tile n={snap.all_markets - snap.markets} k="retired markets" />
      </div>

      <Panel flush={false}>
        <p className="tight">
          <span className={`badge ${says.tone}`}>{says.label}</span>{" "}
          {snap.latest_price_date ? (
            <>
              Prices last moved on <strong>{snap.latest_price_date}</strong>
              {snap.days_since_update !== null ? (
                <span className="muted">
                  {" "}
                  — {snap.days_since_update} day{snap.days_since_update === 1 ? "" : "s"} ago
                </span>
              ) : null}
              {snap.brand.cadence ? (
                <span className="muted"> · publishes {snap.brand.cadence}</span>
              ) : null}
            </>
          ) : (
            <>This brand holds no prices yet.</>
          )}
        </p>
      </Panel>

      <div className="split">
        <Panel title="Recent prices" hint="newest first">
          <table className="tight">
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Price</th>
                <th>Dated</th>
              </tr>
            </thead>
            <tbody>
              {snap.recent.map((row, at) => (
                <tr key={`${row.market}-${row.price_date}-${at}`}>
                  <td>{row.market}</td>
                  <td className="num">{money(Number(row.price), row.currency ?? undefined)}</td>
                  <td>{row.price_date}</td>
                </tr>
              ))}
              {snap.recent.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <Empty>No prices published for this brand yet.</Empty>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>

        <Panel title="Last price update" hint="what the module staged">
          <table className="tight">
            <tbody>
              <tr>
                <td>Batches</td>
                <td className="num">{count(batches.total)}</td>
              </tr>
              {batches.rows.slice(0, 4).map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/dashboard/sites/${slug}/batches/${row.id}`}>#{row.id}</Link>
                    <div className="small muted">{row.source}</div>
                  </td>
                  <td className="num">
                    <span className="badge">{row.status}</span>
                  </td>
                </tr>
              ))}
              {batches.total === 0 ? (
                <tr>
                  <td colSpan={2}>
                    <Empty>
                      The price module has never staged an update for this brand. Seven of the
                      nine brands are in that position.
                    </Empty>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
