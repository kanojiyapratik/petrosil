/**
 * Manage qty trend.
 *
 * Two things in one screen because they are two halves of one job: the
 * places a quantity can be reported for, and the quantities reported. The
 * old admin split them across `qtylocations` (146 rows, most of them hidden)
 * and `globalqties` (24 rows) with no way to see that 122 of the places had
 * never had a number against them.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { tradeMatrix, tradePlaces, tradeSeries } from "@/domain/dashboard/trade";
import {
  BrandField,
  Empty,
  Filters,
  Heading,
  Panel,
  count,
  one,
  type Search,
} from "../../ui";

export const metadata = { title: "Manage qty trend · Petrosil" };
export const dynamic = "force-dynamic";

const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

export default async function QtyPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;
  const site = one(search, "site");
  const date = one(search, "date");

  const [brands, places, series, matrix] = await Promise.all([
    brandsFor(viewer.siteIds),
    tradePlaces(viewer.siteIds, "qty", { site }),
    tradeSeries(viewer.siteIds, { site, kind: "qty" }),
    tradeMatrix(viewer.siteIds, { site, kind: "qty", date }),
  ]);

  const unused = places.filter((place) => place.flows === 0).length;
  const high = Math.max(1, ...series.map((point) => point.total));

  return (
    <>
      <Heading
        title="Manage qty trend"
        sub="The places a quantity is reported for, and the quantities reported against them."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/qty">
          <BrandField brands={brands} value={site} />
          <div className="field">
            <label htmlFor="date">On date</label>
            <input id="date" name="date" type="date" defaultValue={date ?? ""} />
          </div>
        </Filters>
      </Panel>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(places.length)}</div>
          <div className="k">places</div>
        </div>
        <div className="tile">
          <div className="n">{count(unused)}</div>
          <div className="k">never reported on</div>
        </div>
        <div className="tile">
          <div className="n">{count(series.length)}</div>
          <div className="k">dates with data</div>
        </div>
        <div className="tile">
          <div className="n">{matrix.date ?? "—"}</div>
          <div className="k">latest</div>
        </div>
      </div>

      {series.length > 1 ? (
        <Panel title="Total reported, by date" flush={false} hint="Oldest left.">
          <div className="chart" role="img" aria-label={`${series.length} dates`}>
            {series.map((point) => (
              <div
                key={point.date}
                className="bar-col"
                style={{ height: `${8 + (point.total / high) * 92}%` }}
                title={`${point.date}: ${qty(point.total)} across ${point.pairs} pairs`}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel
        title={matrix.date ? `Quantities on ${matrix.date}` : "Quantities"}
        hint={matrix.date ? `${qty(matrix.total)} in total` : undefined}
      >
        <table className="tight">
          <thead>
            <tr>
              <th>From</th>
              {matrix.columns.map((column) => (
                <th key={column} className="num">
                  {column}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const byTo = new Map(row.cells.map((cell) => [cell.to, cell.qty]));

              return (
                <tr key={row.from}>
                  <td>
                    <strong>{row.from}</strong>
                  </td>
                  {matrix.columns.map((column) => (
                    <td key={column} className="num">
                      {byTo.has(column) ? qty(byTo.get(column)!) : <span className="muted">—</span>}
                    </td>
                  ))}
                  <td className="num">
                    <strong>{qty(row.total)}</strong>
                  </td>
                </tr>
              );
            })}
            {matrix.rows.length === 0 ? (
              <tr>
                <td colSpan={2}>
                  <Empty>
                    {matrix.date
                      ? "Nothing reported on that date."
                      : "No quantities recorded for this brand."}
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <Panel title={`${count(places.length)} place${places.length === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Place</th>
              <th>Brand</th>
              <th>Shown</th>
              <th className="num">Rows mentioning it</th>
            </tr>
          </thead>
          <tbody>
            {places.map((place) => (
              <tr key={place.id}>
                <td>
                  <strong>{place.title}</strong>
                </td>
                <td>{place.site}</td>
                <td>
                  <span className={`badge ${place.visible ? "ok" : ""}`}>
                    {place.visible ? "live" : "hidden"}
                  </span>
                </td>
                <td className="num">
                  {place.flows === 0 ? <span className="muted">none</span> : count(place.flows)}
                </td>
              </tr>
            ))}
            {places.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>No qty places set up.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
