/**
 * Discount codes.
 *
 * The state column is the whole point: the old screen showed "active" from
 * the enabled flag alone, so "but the coupon is active" was a recurring
 * support thread about codes that had expired or been spent.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listCoupons } from "@/domain/dashboard/catalogue";
import { CouponForm } from "./form";
import { Empty, Heading, Panel, count, money, one, type Search } from "../../ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Coupons · Petrosil" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  live: "ok",
  scheduled: "warn",
  expired: "bad",
  "used up": "bad",
  off: "",
};

export default async function CouponsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const [rows, brands] = await Promise.all([listCoupons(viewer.siteIds), brandsFor(viewer.siteIds)]);
  const justMade = one(await searchParams, "saved") === "1";
  // Estate-wide codes are listed for everyone but only a superadmin may change one.
  const editable = (site: string | null) => site !== null || viewer.isSuperadmin;

  const live = rows.filter((row) => row.state === "live").length;

  return (
    <>
      <Heading
        title="Coupons"
        sub="A code with no brand works on every brand. Codes are matched upper-cased, however they are typed."
      >
        <Popup label="New code" title="New discount code">
          <CouponForm brands={brands} superadmin={viewer.isSuperadmin} />
        </Popup>
      </Heading>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(live)}</div>
          <div className="k">working today</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.length - live)}</div>
          <div className="k">not working</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.reduce((sum, row) => sum + row.redeemed, 0))}</div>
          <div className="k">times redeemed</div>
        </div>
      </div>

      {justMade ? (
        <p className="flash" role="status">
          Code created.
        </p>
      ) : null}

      <Panel title={`${count(rows.length)} code${rows.length === 1 ? "" : "s"}`}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Takes off</th>
              <th>Works on</th>
              <th>Window</th>
              <th className="num">Used</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {editable(row.site) ? (
                    <Link href={`/dashboard/coupons/${row.id}`}>
                      <strong>
                        <code>{row.code}</code>
                      </strong>
                    </Link>
                  ) : (
                    <strong>
                      <code>{row.code}</code>
                    </strong>
                  )}
                </td>
                <td>
                  {row.percent_off !== null
                    ? `${row.percent_off}%`
                    : money(row.amount_off, row.currency)}
                </td>
                <td>{row.site ?? <span className="muted">every brand</span>}</td>
                <td>
                  {row.starts_at ?? "already"} → {row.expires_at ?? "no end"}
                </td>
                <td className="num">
                  {count(row.redeemed)}
                  {row.max_redemptions !== null ? (
                    <div className="small muted">of {count(row.max_redemptions)}</div>
                  ) : null}
                </td>
                <td>
                  <span className={`badge ${TONE[row.state] ?? ""}`}>{row.state}</span>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>No discount codes.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
