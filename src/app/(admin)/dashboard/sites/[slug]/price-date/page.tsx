/**
 * Correct a whole date — the old admin's list of price dates. Each date opens
 * its prices, where wrong ones are withdrawn and re-entered; the rules are in
 * `domain/price/date-corrections.ts`.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { PER_PAGE, priceDates } from "@/domain/price/date-corrections";
import { today } from "@/domain/price/dates";
import { openDateAction } from "./actions";
import { Empty, Heading, Pager, Panel, count, one, pageParam, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Price dates · Petrosil" };
export const dynamic = "force-dynamic";

export default async function PriceDatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const page = pageParam(one(await searchParams, "page"));
  const { markets, total, rows } = await priceDates(viewer, { site: slug, page });

  return (
    <>
      <Heading
        title="Correct a whole date"
        sub="Every date with published prices. Open one to withdraw wrong figures, then enter the right ones on the price grid."
      />

      <form action={openDateAction} className="bar" style={{ marginBottom: 16 }}>
        <input type="hidden" name="site" value={slug} />
        <div className="field">
          <label htmlFor="jump-date">Go to a date</label>
          <input id="jump-date" name="date" type="date" required max={today()} />
        </div>
        <button type="submit" className="ghost">
          Open
        </button>
      </form>

      <Panel title={`${count(total)} dates`} hint={`${count(markets)} markets on this brand`}>
        {rows.length ? (
          <table className="tight">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Prices published</th>
                <th className="num">Markets without one</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.date}>
                  <td>
                    <Link href={`/dashboard/sites/${slug}/price-date/${row.date}`}>{row.date}</Link>
                  </td>
                  <td className="num">{count(row.prices)}</td>
                  <td className="num">{markets > row.prices ? count(markets - row.prices) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No prices published on this brand yet.</Empty>
        )}
        <Pager base={`/dashboard/sites/${slug}/price-date`} here={{}} page={page} perPage={PER_PAGE} total={total} />
      </Panel>
    </>
  );
}
