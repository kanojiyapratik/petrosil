/**
 * The crawler's watch list.
 *
 * A URL that stops working is the quiet failure in this estate: nothing
 * breaks, prices simply stop arriving from it. So the status and when it was
 * last read are the two columns, and a URL nobody has checked in a week is
 * the thing this screen exists to surface.
 *
 * A URL removed from the list is disabled rather than deleted — its findings
 * are the history, and a typo must not cascade that away.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listWatchedUrls } from "@/domain/dashboard/catalogue";
import { crawlSettings, watchedUrls } from "@/domain/crawl/urls";
import { WatchListForm } from "./form";
import {
  Empty,
  Heading,
  Panel,
  count,
  one,
  when,
  type Search,
} from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Watched pages · Petrosil" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  updated: "ok",
  no_change: "ok",
  unchanged: "ok",
  no_rows: "warn",
  disallowed: "bad",
  blocked: "bad",
  gone: "bad",
  failed: "bad",
};

/** The hostname, or the URL itself if it predates the scheme check. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export default async function CrawlPage({
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
    listWatchedUrls(viewer.siteIds, { site }),
  ]);

  // Editing is per brand -- the list belongs to one site and replacing it is
  // all-or-nothing -- so the editor appears once a brand is chosen with the
  // filter above rather than through a second control of its own.
  const chosen = brands.find((brand) => brand.slug === site);
  const editing = chosen
    ? {
        brand: chosen,
        urls: (await watchedUrls(chosen.id, true)).map((row) => row.url),
        settings: await crawlSettings(chosen.id),
      }
    : null;

  const watching = rows.filter((row) => row.enabled).length;
  const failing = rows.filter(
    (row) => row.enabled && ["gone", "failed", "blocked", "disallowed"].includes(row.last_status ?? ""),
  ).length;

  return (
    <>
      <Heading
        title="Watched pages"
        sub="Pages the crawler reads for prices. Removing one disables it; its findings stay."
      >
        {editing ? (
          <Popup label="Edit the watch list" title={`What ${editing.brand.name} watches`}>
            <WatchListForm
              site={editing.brand.slug}
              siteName={editing.brand.name}
              urls={editing.urls}
              instructions={editing.settings.instructions}
              intervalMinutes={editing.settings.intervalMinutes}
            />
          </Popup>
        ) : null}
      </Heading>

      {editing ? null : brands.length > 1 ? (
        <div className="note" style={{ marginTop: 16 }}>
          Pick a brand above to change what it watches. The list belongs to one brand and is
          replaced whole, so there is nothing sensible to edit across all of them at once.
        </div>
      ) : null}

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(watching)}</div>
          <div className="k">being watched</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.length - watching)}</div>
          <div className="k">stopped</div>
        </div>
        <div className="tile">
          <div className="n">{count(failing)}</div>
          <div className="k">failing to read</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.reduce((sum, row) => sum + row.findings, 0))}</div>
          <div className="k">findings recorded</div>
        </div>
      </div>

      <Panel title={`${count(rows.length)} URL${rows.length === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Page</th>
              <th>Last read said</th>
              <th className="num">Rows</th>
              <th className="num">Findings</th>
              <th>Last read</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.label ?? hostOf(row.url)}</strong>
                  <div className="small muted">{row.url}</div>
                  {!row.enabled ? <div className="small muted">stopped</div> : null}
                </td>
                <td>
                  <span className={`badge ${TONE[row.last_status ?? ""] ?? ""}`}>
                    {row.status_label}
                  </span>
                  {row.last_error ? <div className="small muted">{row.last_error}</div> : null}
                </td>
                <td className="num">{count(row.last_row_count)}</td>
                <td className="num">{count(row.findings)}</td>
                <td>
                  {row.last_checked_at ? when(row.last_checked_at) : <span className="muted">never</span>}
                  {row.last_changed_at ? (
                    <div className="small muted">moved {when(row.last_changed_at)}</div>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>
                    No URLs on the watch list. The price module&rsquo;s console sets these per brand.
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
