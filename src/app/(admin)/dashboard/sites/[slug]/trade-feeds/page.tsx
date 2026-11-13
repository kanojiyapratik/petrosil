/**
 * Trade feeds — monthly import and export quantities from government
 * statistics, instead of typed in.
 *
 * Each feed fills one sheet (a reporting country, one direction) from one
 * source. The engine checks every six hours for months the sheet is
 * missing; what it finds waits here to be published, and once published
 * the brand's model writes a market insight on it.
 */

import Link from "@/lib/ui/link";

import { currentViewer } from "@/lib/auth/server";
import { TRADE_SOURCES } from "@/db/schema";
import { SOURCE_LABELS, listFeeds, monthName } from "@/domain/trade/feeds";
import { Empty, Heading, Panel, count, one, type Search } from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";
import { CheckNow, FeedActions, FeedForm } from "./forms";

export const metadata = { title: "Trade feeds · Petrosil" };
export const dynamic = "force-dynamic";

const whenText = (date: Date | null) =>
  date ? date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never";

const STATUS: Record<string, string> = {
  read: "found a new month",
  no_data: "nothing new yet",
  failed: "could not read the source",
};

export default async function TradeFeedsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const view = await listFeeds(viewer, slug);
  const sources = TRADE_SOURCES.map((key) => ({ key, label: SOURCE_LABELS[key] }));
  const waiting = view.updates.filter((update) => update.status === "pending");
  const done = one(search, "done");

  return (
    <>
      <Heading
        title="Trade feeds"
        sub="Import and export quantities read from government statistics every six hours, held here for you to publish."
      >
        <CheckNow slug={slug} />
        <Popup label="Add a feed" title="Add a trade feed">
          <FeedForm slug={slug} places={view.places} sources={sources} start={null} />
        </Popup>
      </Heading>

      {done === "discarded" ? <p className="flash">Discarded.</p> : null}

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(view.feeds.length)}</div>
          <div className="k">feeds</div>
        </div>
        <div className="tile">
          <div className="n">{count(waiting.length)}</div>
          <div className="k">months waiting to be published</div>
        </div>
      </div>

      <Panel title="Waiting to be published" hint="Open one to check it against the sheet.">
        {waiting.length === 0 ? (
          <Empty>Nothing waiting. New months appear here as the sources publish them.</Empty>
        ) : (
          <table className="tight">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Month</th>
                <th className="num">Partners</th>
                <th className="num">Total</th>
                <th>Needs</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((update) => (
                <tr key={update.id}>
                  <td>
                    <Link href={`/dashboard/sites/${slug}/trade-feeds/${update.id}`}>
                      <strong>
                        {update.feed?.reporter} {update.feed?.kind}s
                      </strong>
                    </Link>
                    <div className="small muted">{update.feed?.product}</div>
                  </td>
                  <td>{monthName(update.month)}</td>
                  <td className="num">{count(update.partners)}</td>
                  <td className="num">{count(Math.round(update.total))}</td>
                  <td>
                    {update.unmatched ? <span className="badge bad">{update.unmatched} to match</span> : <span className="badge ok">ready</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Feeds">
        {view.feeds.length === 0 ? (
          <Empty>No feeds yet. Add one for each reporting country and direction this brand publishes.</Empty>
        ) : (
          <table className="tight">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Source and codes</th>
                <th>Sheet holds up to</th>
                <th>Last check</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.feeds.map((feed) => (
                <tr key={feed.id} className={feed.enabled ? undefined : "muted"}>
                  <td>
                    <strong>
                      {feed.reporter} {feed.kind}s
                    </strong>
                    <div className="small muted">
                      {feed.product}
                      {feed.auto_publish ? " · publishes on its own" : ""}
                      {feed.enabled ? "" : " · off"}
                    </div>
                  </td>
                  <td>
                    {feed.source_label}
                    <div className="small muted">{feed.hs_codes.join(", ")}</div>
                  </td>
                  <td>{feed.latest_month ? monthName(feed.latest_month) : "nothing yet"}</td>
                  <td>
                    {whenText(feed.last_checked_at)}
                    {feed.last_status ? <div className={`small ${feed.last_status === "failed" ? "bad" : "muted"}`}>{STATUS[feed.last_status] ?? feed.last_status}</div> : null}
                    {feed.last_error && feed.last_status === "failed" ? <div className="small muted">{feed.last_error}</div> : null}
                  </td>
                  <td className="actions-cell">
                    <Popup label="Edit" title={`Edit ${feed.reporter} ${feed.kind}s`} ghost>
                      <FeedForm slug={slug} places={view.places} sources={sources} start={feed} />
                    </Popup>
                    <FeedActions slug={slug} id={feed.id} enabled={feed.enabled} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recently decided">
        {view.updates.filter((update) => update.status !== "pending").length === 0 ? (
          <Empty>Nothing published from a feed yet.</Empty>
        ) : (
          <table className="tight">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Month</th>
                <th>Outcome</th>
                <th>Market insight</th>
              </tr>
            </thead>
            <tbody>
              {view.updates
                .filter((update) => update.status !== "pending")
                .slice(0, 20)
                .map((update) => (
                  <tr key={update.id}>
                    <td>
                      <Link href={`/dashboard/sites/${slug}/trade-feeds/${update.id}`}>
                        {update.feed?.reporter} {update.feed?.kind}s
                      </Link>
                    </td>
                    <td>{monthName(update.month)}</td>
                    <td>{update.status}</td>
                    <td>{update.insight ?? (update.status === "published" ? "being written" : "—")}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
