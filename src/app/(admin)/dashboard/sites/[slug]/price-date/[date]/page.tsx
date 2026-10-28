/** One date's published prices: withdraw the wrong ones, put a withdrawal back. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { AccountError } from "@/domain/accounts/register";
import { dateSheet } from "@/domain/price/date-corrections";
import { PutBack, WithdrawForm } from "../forms";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

const figure = (value: string) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 4 });

export default async function PriceDatePage({ params }: { params: Promise<{ slug: string; date: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, date } = await params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    notFound();
  }

  let sheet;

  try {
    sheet = await dateSheet(viewer, { site: slug, date });
  } catch (error) {
    if (error instanceof AccountError && error.field === "date") {
      notFound();
    }

    throw error;
  }

  const day = new Date(`${sheet.date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const missing = sheet.markets - sheet.prices.length;

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/price-date`}>
        ← Price dates
      </Link>

      <Heading
        title={`Prices on ${day}`}
        sub="A published price is not edited in place. Withdraw the wrong ones, then enter the right figures on the price grid."
      >
        <Link className="button" href={`/dashboard/sites/${slug}/price-entry?date=${sheet.date}`}>
          Open in the price grid
        </Link>
      </Heading>

      <Panel
        title={`${count(sheet.prices.length)} published`}
        hint={missing > 0 ? `${count(missing)} market${missing === 1 ? "" : "s"} without a price on this date` : "every market has a price"}
        flush={false}
      >
        {sheet.prices.length ? (
          <WithdrawForm key={sheet.prices.map((row) => row.id).join(",")} slug={slug} date={sheet.date} rows={sheet.prices} />
        ) : (
          <Empty>Nothing is published on this date.</Empty>
        )}
      </Panel>

      {sheet.withdrawals.length ? (
        <Panel title="Withdrawn from this date" hint="Newest first. Putting back keeps any figure entered since.">
          <table className="tight">
            <thead>
              <tr>
                <th>When</th>
                <th>Prices</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sheet.withdrawals.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.at.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    <div className="small muted">by {row.by ?? "unknown"}</div>
                  </td>
                  <td className="small">
                    {row.prices
                      .slice(0, 6)
                      .map((price) => `${price.title} ${figure(price.price)}`)
                      .join(" · ")}
                    {row.prices.length > 6 ? ` · and ${row.prices.length - 6} more` : ""}
                  </td>
                  <td>
                    {row.putBackAt ? (
                      <span className="small muted">put back {row.putBackAt.toLocaleDateString("en-GB")}</span>
                    ) : (
                      <PutBack slug={slug} withdrawal={row.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </>
  );
}
