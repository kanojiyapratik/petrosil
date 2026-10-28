/**
 * Enter prices by hand — the old admin's per-market grid, for one date at a
 * time. The rules (empty means leave it, past figures are history, every
 * save is a price update) are in `domain/price/entry.ts`.
 */

import { currentViewer } from "@/lib/auth/server";
import { AccountError } from "@/domain/accounts/register";
import { AccessError } from "@/lib/auth/guard";
import { entrySheet, type EntrySheet } from "@/domain/price/entry";
import { today } from "@/domain/price/dates";
import { EntryForm } from "./form";
import { openDateAction } from "./actions";
import { Empty, Heading, Panel, one, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Enter prices · Petrosil" };
export const dynamic = "force-dynamic";

export default async function PriceEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const date = one(await searchParams, "date") ?? today();

  let sheet: EntrySheet | null = null;
  let problem: string | null = null;

  try {
    sheet = await entrySheet(viewer, { site: slug, date });
  } catch (error) {
    if (!(error instanceof AccountError || error instanceof AccessError)) {
      throw error;
    }

    problem = error.message;
  }

  const filled = sheet ? sheet.rows.filter((row) => row.onDate !== null).length : 0;

  return (
    <>
      <Heading
        title="Enter prices"
        sub="A price for each market on one date. Empty boxes are left as they are; what you save publishes at once."
      />

      <form action={openDateAction} className="bar" style={{ marginBottom: 16 }}>
        <input type="hidden" name="site" value={slug} />
        <div className="field">
          <label htmlFor="entry-date">Price date</label>
          <input id="entry-date" name="date" type="date" required max={today()} defaultValue={sheet?.date ?? date} />
        </div>
        <button type="submit" className="ghost">
          Open the date
        </button>
      </form>

      {problem ? (
        <p className="flash bad" role="alert">
          {problem}
        </p>
      ) : null}

      {sheet ? (
        <Panel
          title={`${sheet.rows.length} markets`}
          hint={
            sheet.past
              ? `${filled} already published on this past date and fixed; the other ${sheet.rows.length - filled} can still be filled.`
              : `${filled} already have a price on this date.`
          }
          flush={false}
        >
          {sheet.rows.length ? (
            <EntryForm key={sheet.date} slug={slug} date={sheet.date} past={sheet.past} rows={sheet.rows} />
          ) : (
            <Empty>This brand has no markets yet. Add one under Markets.</Empty>
          )}
        </Panel>
      ) : null}
    </>
  );
}
