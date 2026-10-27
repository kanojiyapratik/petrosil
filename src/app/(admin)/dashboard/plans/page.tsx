/**
 * The plan catalogue.
 *
 * One row per plan, with every term it can be bought for and how many have
 * actually been paid for. The old admin reached multi-year pricing through
 * `getPrice/{plan}/{year}`, one page per combination, so what a brand sells
 * could not be read in one go.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listPlans } from "@/domain/dashboard/catalogue";
import {
  BrandField,
  Empty,
  Filters,
  Heading,
  Panel,
  count,
  money,
  one,
  type Search,
} from "../../ui";

export const metadata = { title: "Plans · Petrosil" };
export const dynamic = "force-dynamic";

export default async function PlansPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;
  const site = one(search, "site");

  const [brands, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    listPlans(viewer.siteIds, { site }),
  ]);

  return (
    <>
      <Heading
        title="Plans"
        sub="What each brand sells, and for how long. Hidden plans still honour the orders already placed against them."
      >
        <Link className="button small" href="/dashboard/plans/new">
          New plan
        </Link>
      </Heading>

      <Panel flush={false}>
        <Filters action="/dashboard/plans" site={site}>
          <BrandField brands={brands} value={site} />
        </Filters>
      </Panel>

      <Panel title={`${count(rows.length)} plan${rows.length === 1 ? "" : "s"}`}>
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Brand</th>
              <th>Terms</th>
              <th>Shown</th>
              <th className="num">Sold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/plans/${row.id}`}>
                    <strong>{row.name}</strong>
                  </Link>
                  <div className="small muted">
                    <code>{row.code}</code>
                    {row.description ? ` · ${row.description}` : ""}
                  </div>
                </td>
                <td>{row.site_name}</td>
                <td>
                  {row.terms.length === 0 ? (
                    <span className="muted">no price set</span>
                  ) : (
                    row.terms.map((term) => (
                      <span key={term.years} className="tag" style={{ marginRight: 4 }}>
                        {term.years}y {money(term.amount, row.currency)}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <span className={`badge ${row.visible ? "ok" : ""}`}>
                    {row.visible ? "on sale" : "hidden"}
                  </span>
                </td>
                <td className="num">{count(row.sold)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No plans set up. The brand sites will have nothing to sell.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
