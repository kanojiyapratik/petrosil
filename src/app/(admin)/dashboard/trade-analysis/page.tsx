/**
 * Trade analysis — imports and exports, by route and by date.
 *
 * 125,834 quantity rows across the estate between a handful of named places,
 * which the old admin showed as a paginated table of raw rows. The two
 * things anyone asks of it are the trend and the latest routes, so it is
 * those two: a series you can see the shape of, and one date laid out as a
 * matrix.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { tradeMatrix, tradePlaces, tradeSeries } from "@/domain/dashboard/trade";
import { TRADE_KINDS, type TradeKind } from "@/db/schema";
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

export const metadata = { title: "Trade analysis · Petrosil" };
export const dynamic = "force-dynamic";

const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

export default async function TradeAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const date = one(search, "date");
  const asked = one(search, "kind");
  const kind: TradeKind = TRADE_KINDS.includes(asked as TradeKind)
    ? (asked as TradeKind)
    : "import";

  const [brands, series, matrix, places] = await Promise.all([
    brandsFor(viewer.siteIds),
    tradeSeries(viewer.siteIds, { site, kind, limit: 120 }),
    tradeMatrix(viewer.siteIds, { site, kind, date }),
    tradePlaces(viewer.siteIds, kind, { site }),
  ]);

  const high = Math.max(1, ...series.map((point) => point.total));
  const here = new URLSearchParams();

  if (site) {
    here.set("site", site);
  }

  return (
    <>
      <Heading
        title="Trade analysis"
        sub="What moved between where, and when. Pick imports or exports."
      />

      <div className="chips" style={{ marginBottom: 14 }}>
        {(["import", "export"] as const).map((value) => {
          const query = new URLSearchParams(here);
          query.set("kind", value);

          return (
            <Link
              key={value}
              className={`chip${kind === value ? " on" : ""}`}
              href={`/dashboard/trade-analysis?${query.toString()}`}
            >
              {value}s
            </Link>
          );
        })}
      </div>

      <Panel flush={false}>
        <Filters action="/dashboard/trade-analysis">
          <BrandField brands={brands} value={site} />
          <div className="field">
            <label htmlFor="date">On date</label>
            <input id="date" name="date" type="date" defaultValue={date ?? ""} />
          </div>
          <input type="hidden" name="kind" value={kind} />
        </Filters>
      </Panel>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(places.length)}</div>
          <div className="k">{kind} places</div>
        </div>
        <div className="tile">
          <div className="n">{count(series.length)}</div>
          <div className="k">dates with data</div>
        </div>
        <div className="tile">
          <div className="n">{matrix.date ?? "—"}</div>
          <div className="k">latest</div>
        </div>
        <div className="tile">
          <div className="n">{qty(matrix.total)}</div>
          <div className="k">moved that day</div>
        </div>
      </div>

      {series.length > 1 ? (
        <Panel
          title={`${kind}s over time`}
          flush={false}
          hint={`${count(series.length)} dates, oldest left.`}
        >
          <div className="chart" role="img" aria-label={`${series.length} dates`}>
            {series.map((point) => (
              <div
                key={point.date}
                className="bar-col"
                style={{ height: `${8 + (point.total / high) * 92}%` }}
                title={`${point.date}: ${qty(point.total)} across ${point.pairs} routes`}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel
        title={matrix.date ? `Routes on ${matrix.date}` : "Routes"}
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
                      ? "Nothing moved on that date."
                      : `No ${kind} quantities recorded.`}
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
