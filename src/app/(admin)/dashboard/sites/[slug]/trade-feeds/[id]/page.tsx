/**
 * One fetched month: the source's figures partner by partner, beside what
 * the sheet holds, to publish or discard — and once published, the market
 * insight the brand's model wrote from it.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { AccountError } from "@/domain/accounts/register";
import { tradeUpdate } from "@/domain/trade/feeds";
import { Heading, Panel, count } from "@/app/(admin)/ui";
import { Discard, Review, WriteInsight } from "../forms";

export const metadata = { title: "Trade update · Petrosil" };
export const dynamic = "force-dynamic";

export default async function TradeUpdatePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  let view: Awaited<ReturnType<typeof tradeUpdate>>;

  try {
    view = await tradeUpdate(viewer, slug, Number(id));
  } catch (error) {
    if (error instanceof AccountError && error.status === 404) {
      notFound();
    }

    throw error;
  }

  const pending = view.status === "pending";
  const total = view.rows.filter((row) => !row.skipped).reduce((sum, row) => sum + row.qty, 0);
  const unmatched = view.rows.filter((row) => row.location_id === null && !row.skipped).length;
  const unit = view.source_unit === "LTR" ? "thousand litres" : "tonnes";

  return (
    <>
      <Heading
        title={`${view.reporter} ${view.kind}s — ${view.month_name}`}
        sub={`${view.product}, from ${view.source} (codes ${view.codes.join(", ")}). Figures in ${unit}, as the sheet has always held them.`}
      >
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/trade-feeds`}>
          All feeds
        </Link>
        {pending ? <Discard slug={slug} id={view.id} /> : null}
      </Heading>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(Math.round(total))}</div>
          <div className="k">{unit} in all</div>
        </div>
        <div className="tile">
          <div className="n">{count(view.rows.length)}</div>
          <div className="k">partner countries</div>
        </div>
        <div className="tile">
          <div className="n">{pending ? count(unmatched) : view.status}</div>
          <div className="k">{pending ? "to match before publishing" : "status"}</div>
        </div>
      </div>

      {view.source_url ? (
        <p className="small muted">
          Read from{" "}
          <a href={view.source_url} target="_blank" rel="noreferrer">
            the source
          </a>{" "}
          on {view.fetched_at.toLocaleString("en-GB")}.
        </p>
      ) : null}

      <Panel title="The month, partner by partner" hint={pending ? "Publishing replaces the sheet's figures for this month." : undefined}>
        <Review slug={slug} id={view.id} rows={view.rows} places={view.places} pendingUpdate={pending} />
      </Panel>

      {pending && view.dropped.length ? (
        <Panel title="On the sheet but not in the source" hint="Removed when this month is published.">
          <table className="tight">
            <tbody>
              {view.dropped.map((row) => (
                <tr key={row.place}>
                  <td>{row.place}</td>
                  <td className="num">{count(row.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {view.status === "published" ? (
        <Panel
          title="Market insight"
          hint={view.insight.model ? `Written by ${view.insight.model}` : undefined}
          aside={<WriteInsight slug={slug} id={view.id} again={Boolean(view.insight.text)} />}
          flush={false}
        >
          {view.insight.text ? (
            <div className="prose">
              {view.insight.text.split(/\n{2,}/).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          ) : view.insight.error ? (
            <p className="bad">The model did not write it: {view.insight.error}</p>
          ) : (
            <p className="muted">Being written — refresh in a moment.</p>
          )}
        </Panel>
      ) : null}
    </>
  );
}
