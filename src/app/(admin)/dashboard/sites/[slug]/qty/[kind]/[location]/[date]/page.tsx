/** One month's sheet: a quantity box for every partner country. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { SHEET_KINDS, sheetFor, type SheetKind } from "@/domain/trade/sheets";
import { SheetForm } from "../../../forms";
import { Heading, Panel } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function MonthSheetPage({
  params,
}: {
  params: Promise<{ slug: string; kind: string; location: string; date: string }>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, kind: raw, location: id, date } = await params;

  if (!(SHEET_KINDS as readonly string[]).includes(raw) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    notFound();
  }

  const kind = raw as SheetKind;
  const sheet = await sheetFor(viewer.siteIds, { site: slug, kind, location: Number(id), date });

  if (!sheet) {
    notFound();
  }

  const month = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/qty/${kind}/${sheet.location.id}`}>
        ← {sheet.location.title} · {kind}s
      </Link>

      <Heading
        title={`${sheet.location.title} ${kind}s · ${month}`}
        sub={
          kind === "export"
            ? `What ${sheet.location.title} sent to each country in ${month}.`
            : `What ${sheet.location.title} received from each country in ${month}.`
        }
      />

      <Panel
        title={`${sheet.rows.length} partner countries`}
        hint={`Total now ${sheet.total.toLocaleString("en-IN", { maximumFractionDigits: 3 })}`}
        flush={false}
      >
        <SheetForm slug={slug} kind={kind} location={sheet.location.id} date={date} rows={sheet.rows} />
      </Panel>
    </>
  );
}
