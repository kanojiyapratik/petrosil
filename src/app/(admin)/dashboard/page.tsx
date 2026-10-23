/**
 * The estate overview — the screen the nine PHP admins never had.
 *
 * Each of those showed one brand, because each ran its own database. The
 * one thing a single platform can say that nine copies could not is how the
 * whole estate is doing at once, so that is what opens the admin.
 *
 * It reads the domain directly rather than calling its own HTTP API: same
 * scoping (`visibleSites`), one less round trip, and the type survives.
 */

import { currentViewer } from "@/lib/auth/server";
import { estateOverview } from "@/domain/dashboard/overview";
import { Tile } from "../ui";

export const metadata = { title: "Overview · Petrosil" };
export const dynamic = "force-dynamic";

const FRESHNESS: Record<string, { label: string; tone: string }> = {
  fresh: { label: "up to date", tone: "ok" },
  due: { label: "due", tone: "warn" },
  stale: { label: "overdue", tone: "bad" },
  none: { label: "no prices", tone: "" },
};

const count = (n: number) => n.toLocaleString("en-IN");

export default async function DashboardPage() {
  const viewer = (await currentViewer())!;
  const overview = await estateOverview(viewer.siteIds);
  const { totals } = overview;

  return (
    <>
      <h1>Estate overview</h1>

      <div className="tiles">
        <Tile n={totals.sites} k="brands" />
        <Tile n={totals.live_locations} k="published markets" />
        <Tile n={totals.prices} k="prices held" />
        <Tile n={totals.users} k="registered people" />
        <Tile n={totals.premium} k="paying now" />
        <Tile n={totals.trial} k="on trial" />
        <Tile n={totals.expired} k="lapsed" />
        <Tile n={totals.committed_batches_30d} k="updates, 30 days" />
      </div>

      <div className="panel">
        <div className="head">
          <h2>Brands</h2>
          <span className="spacer" />
          <span className="hint">Freshness is judged against each brand&rsquo;s own cadence.</span>
        </div>
        <div className="body flush">
          <table>
            <thead>
              <tr>
                <th>Brand</th>
                <th>Last published</th>
                <th>Status</th>
                <th className="num">Markets</th>
                <th className="num">People</th>
                <th className="num">Paying</th>
                <th className="num">Updates</th>
              </tr>
            </thead>
            <tbody>
              {overview.sites.map((site) => {
                const freshness = FRESHNESS[site.freshness]!;

                return (
                  <tr key={site.id}>
                    <td>
                      <strong>{site.name}</strong>
                      <div className="small muted">
                        {site.slug}
                        {site.cadence ? ` · ${site.cadence}` : ""}
                        {site.enabled ? "" : " · switched off"}
                      </div>
                    </td>
                    <td>
                      {site.latest_pricedate ?? "—"}
                      {site.days_since_update !== null ? (
                        <div className="small muted">{site.days_since_update} days ago</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge ${freshness.tone}`}>{freshness.label}</span>
                    </td>
                    <td className="num">
                      {count(site.live_locations)}
                      {site.locations !== site.live_locations ? (
                        <div className="small muted">{count(site.locations)} held</div>
                      ) : null}
                    </td>
                    <td className="num">{count(site.users)}</td>
                    <td className="num">{count(site.premium)}</td>
                    <td className="num">{count(site.committed_batches)}</td>
                  </tr>
                );
              })}
              {overview.sites.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No brands you can see hold any data yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

