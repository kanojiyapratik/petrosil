/**
 * Ads.
 *
 * "Running" is worked out from today against the start and end dates, not
 * read off the publish flag. The old table had 77 ads marked Published, many
 * of them finished years ago, and 247,138 click rows against them with no
 * screen that put the two together.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listAds } from "@/domain/dashboard/promotion";
import {
  Empty,
  Heading,
  Panel,
  count,
  one,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Adverts · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const site = slug;

  const [brands, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    listAds(viewer.siteIds, { site }),
  ]);

  const live = rows.filter((row) => row.live).length;

  return (
    <>
      <Heading
        title="Adverts"
        sub="Running is judged against today, not against the publish flag."
      >
        <Link className="button ghost small" href="/dashboard/global/ad-slots">
          Slots
        </Link>
        <Link className="button small" href={`/dashboard/sites/${slug}/ads/new`}>
          New ad
        </Link>
      </Heading>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(live)}</div>
          <div className="k">running today</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.length - live)}</div>
          <div className="k">not running</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.reduce((sum, row) => sum + row.clicks, 0))}</div>
          <div className="k">clicks recorded</div>
        </div>
      </div>

      <Panel title={`${count(rows.length)} ad${rows.length === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Ad</th>
              <th>Slot</th>
              <th>Runs</th>
              <th>Shown on</th>
              <th>State</th>
              <th className="num">Clicks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/ads/${row.id}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  <div className="small muted">
                    {row.ad_type}
                    {row.url ? ` → ${row.url}` : ""}
                  </div>
                </td>
                <td>
                  {row.placement ?? <span className="muted">unassigned</span>}
                  <div className="small muted">{row.site}</div>
                </td>
                <td>
                  {row.starts_at ?? "already"} → {row.ends_at ?? "no end"}
                </td>
                <td>
                  {row.on_dashboard ? (
                    <span className="tag" style={{ marginRight: 4 }}>
                      website
                    </span>
                  ) : null}
                  {row.on_newsletter ? <span className="tag">newsletter</span> : null}
                  {!row.on_dashboard && !row.on_newsletter ? (
                    <span className="muted">not shown anywhere</span>
                  ) : null}
                </td>
                <td>
                  {row.live ? (
                    <span className="badge ok">running</span>
                  ) : row.enabled ? (
                    <span className="badge warn">outside its dates</span>
                  ) : (
                    <span className="badge">paused</span>
                  )}
                </td>
                <td className="num">{count(row.clicks)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>No ads.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
