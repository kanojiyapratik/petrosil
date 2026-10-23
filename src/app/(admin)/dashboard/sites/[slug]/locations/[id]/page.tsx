/**
 * One location's price history.
 *
 * The column that matters is "batch": it is how an editor answers "where did
 * this figure come from?" without opening the database. Every wrong price
 * the client has ever reported was traced by hand; this is that trace, done
 * once.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { locationDetail } from "@/domain/dashboard/locations";
import { toggleLocation } from "@/app/(admin)/dashboard/actions";
import { Change, Chart, Empty, Heading, Panel, count, money } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function LocationPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;

  const found = await locationDetail(viewer.siteIds, Number(id), 120);

  if (!found) {
    notFound();
  }

  const { location, history } = found;
  const oldest = history[history.length - 1];
  const newest = history[0];

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/locations`}>
        ← Locations
      </Link>

      <Heading title={location.title} sub={`${location.site_name} · ${location.currency ?? "no currency set"}`}>
        <span className={`badge ${location.visible ? "ok" : ""}`}>
          {location.visible ? "published" : "held"}
        </span>
        <form action={toggleLocation}>
          <input type="hidden" name="id" value={location.id} />
          <input type="hidden" name="visible" value={location.visible ? "0" : "1"} />
          <button className="ghost small" type="submit">
            {location.visible ? "Hold it" : "Publish it"}
          </button>
        </form>
      </Heading>

      <div className="tiles">
        <div className="tile">
          <div className="n">{money(location.latest_price, location.currency)}</div>
          <div className="k">latest, {location.latest_pricedate ?? "never"}</div>
        </div>
        <div className="tile">
          <div className="n">{count(location.price_rows)}</div>
          <div className="k">prices on record</div>
        </div>
        <div className="tile">
          <div className="n">
            <Change pct={location.change_pct} />
          </div>
          <div className="k">against the one before</div>
        </div>
        <div className="tile">
          <div className="n">{oldest ? oldest.price_date : "—"}</div>
          <div className="k">history starts</div>
        </div>
      </div>

      {history.length > 1 ? (
        <Panel
          title="Movement"
          hint={`${count(history.length)} assessments, oldest left. Scaled between low and high.`}
          flush={false}
        >
          <Chart points={[...history].reverse()} />
        </Panel>
      ) : null}

      <Panel
        title="History"
        hint={newest ? `Newest first, up to 120 shown.` : undefined}
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Date</th>
              <th>Price</th>
              <th>Change</th>
              <th>Came from</th>
            </tr>
          </thead>
          <tbody>
            {history.map((point) => (
              <tr key={`${point.price_date}-${point.price}`}>
                <td>{point.price_date}</td>
                <td>
                  <strong>{money(point.price, location.currency)}</strong>
                </td>
                <td>
                  <Change pct={point.change_pct} />
                </td>
                <td>
                  {point.batch_id ? (
                    <Link href={`/dashboard/sites/${slug}/batches/${point.batch_id}`}>
                      batch #{point.batch_id}
                    </Link>
                  ) : (
                    <span className="muted">entered directly</span>
                  )}
                  {point.source ? <span className="tag" style={{ marginLeft: 8 }}>{point.source}</span> : null}
                </td>
              </tr>
            ))}
            {history.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>No prices published for this location yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
