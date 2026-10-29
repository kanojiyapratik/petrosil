/**
 * Transactions.
 *
 * The list amount, the discount and what was actually charged are all three
 * shown, because the old checkout posted the price it had been shown and the
 * controller trusted it — so "what did they really pay" needed a database
 * query. `attempts` is how many times settling was tried, which is the
 * difference between a failed card and a failed order.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listTransactions } from "@/domain/dashboard/catalogue";
import { PAYMENT_METHODS } from "@/domain/billing/manual";
import { ORDER_STATUSES } from "@/db/schema";
import {
  Empty,
  Heading,
  Pager,
  Panel,
  count,
  money,
  one,
  pageParam,
  when,
  type Search,
  BrandChips,
  Chips,
} from "../../ui";

export const metadata = { title: "Payments · Petrosil" };
export const dynamic = "force-dynamic";

const METHOD: Record<string, string> = Object.fromEntries(PAYMENT_METHODS.map((row) => [row.key, row.label.toLowerCase()]));

const TONE: Record<string, string> = {
  paid: "ok",
  pending: "warn",
  failed: "bad",
  cancelled: "",
};

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const status = one(search, "status");
  const page = pageParam(one(search, "page"));

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listTransactions(viewer.siteIds, { site, status, page }),
  ]);

  // Per currency, never summed. The estate sells in rupees to the Indian subcontinent and in
  // dollars to everyone else, so one total over both is a number that means
  // nothing -- and this screen printed exactly that.
  const takings = new Map<string, number>();

  for (const row of paged.rows) {
    if (row.status === "paid") {
      takings.set(row.currency, (takings.get(row.currency) ?? 0) + row.amount);
    }
  }

  return (
    <>
      <Heading
        title="Payments"
        sub="Every order, with what it listed at, what was taken off, and what was charged."
      />

      <BrandChips base="/dashboard/transactions" brands={brands} value={site} here={{ status }} />
      <div className="listbar">
        <Chips
          base="/dashboard/transactions"
          param="status"
          here={{ site }}
          value={status}
          options={[
            { value: "", label: "Any status" },
            ...ORDER_STATUSES.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) })),
          ]}
        />
      </div>

      <Panel
        title={`${count(paged.total)} order${paged.total === 1 ? "" : "s"}`}
        hint={
          takings.size === 0
            ? undefined
            : [...takings.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([currency, total]) => money(total, currency))
                .join(" + ") + " paid on this page"
        }
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Order</th>
              <th>Buyer</th>
              <th>Plan</th>
              <th className="num">Listed</th>
              <th className="num">Off</th>
              <th className="num">Charged</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>#{row.id}</strong>
                  <div className="small muted">{row.site}</div>
                </td>
                <td>
                  <Link href={`/dashboard/clients/${row.user_id}`}>{row.who}</Link>
                  <div className="small muted">{row.email}</div>
                </td>
                <td>
                  {row.plan_name}
                  <div className="small muted">
                    {row.years} year{row.years === 1 ? "" : "s"}
                    {row.granted_until ? ` · to ${row.granted_until}` : ""}
                  </div>
                </td>
                <td className="num">{money(row.list_amount, row.currency)}</td>
                <td className="num">
                  {row.discount > 0 ? (
                    <>
                      <span className="down">−{money(row.discount)}</span>
                      {row.coupon_code ? (
                        <div className="small muted">{row.coupon_code}</div>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">
                  <strong>{money(row.amount, row.currency)}</strong>
                </td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>{row.status}</span>
                  <div className="small muted">
                    {row.provider}
                    {row.method ? ` · ${METHOD[row.method] ?? row.method}` : ""}
                    {row.provider === "manual" && row.provider_payment_id ? ` · ${row.provider_payment_id}` : ""}
                    {row.attempts > 1 ? ` · ${row.attempts} attempts` : ""}
                  </div>
                </td>
                <td>
                  {when(row.created_at)}
                  {row.paid_at ? (
                    <div className="small muted">paid {when(row.paid_at)}</div>
                  ) : null}
                </td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>No orders match those filters.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base="/dashboard/transactions"
          here={{ site, status }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
