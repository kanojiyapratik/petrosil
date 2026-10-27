/** One reporting country's months of import or export figures, newest first. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { SHEET_KINDS, monthsFor, sheetFor, type SheetKind } from "@/domain/trade/sheets";
import { today } from "@/domain/price/dates";
import { OpenMonth } from "../../forms";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

const qty = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 3 });

export default async function CountryMonthsPage({
  params,
}: {
  params: Promise<{ slug: string; kind: string; location: string }>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, kind: raw, location: id } = await params;

  if (!(SHEET_KINDS as readonly string[]).includes(raw)) {
    notFound();
  }

  const kind = raw as SheetKind;
  const location = Number(id);
  // The sheet read also answers whether this place is the brand's at all.
  const probe = await sheetFor(viewer.siteIds, { site: slug, kind, location, date: today() });

  if (!probe) {
    notFound();
  }

  const months = await monthsFor(viewer.siteIds, { site: slug, kind, location });

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/qty?kind=${kind}`}>
        ← Import and export quantities
      </Link>

      <Heading
        title={`${probe.location.title} · ${kind}s`}
        sub={kind === "export" ? "What it sent to each partner, month by month." : "What it received from each partner, month by month."}
      />

      <Panel title="Enter or change a month" flush={false}>
        <OpenMonth slug={slug} kind={kind} places={[]} location={location} month={today().slice(0, 7)} />
      </Panel>

      <Panel title={`${count(months.length)} month${months.length === 1 ? "" : "s"} on record`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Partners</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {months.map((month) => (
              <tr key={month.date}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/qty/${kind}/${location}/${month.date}`}>
                    <strong>{month.date.slice(0, 7)}</strong>
                  </Link>
                  {month.date.endsWith("-01") ? null : <span className="small muted"> dated {month.date}</span>}
                </td>
                <td className="num">{count(month.partners)}</td>
                <td className="num">{qty(month.total)}</td>
              </tr>
            ))}
            {months.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <Empty>No months yet. Open one above to enter its figures.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
