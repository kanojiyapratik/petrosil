/**
 * Step two: what the AI read from each report, to be checked before any
 * price is drafted. Correct a figure, fix a name, untick a row that should
 * not count, add one the AI missed — then draft from the ticked rows.
 *
 * This is where a figure is corrected. The draft only ever uses what was
 * left ticked here, so a wrong number caught now never reaches the prices.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { aiReading } from "@/domain/ai/update";
import { Empty, Heading, Panel, one, when, type Search } from "@/app/(admin)/ui";
import { AddRow, DraftForm, RowEditor } from "../../forms";

/** One heading per box RowEditor draws, in its order. */
const COLUMNS = ["Use", "Name", "Price", "Low", "High", "Cur.", "Unit", "Basis", "Date", ""];

export const metadata = { title: "Check what was read · Petrosil" };
export const dynamic = "force-dynamic";

export default async function ReadingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const search = await searchParams;
  const setId = Number(id);

  if (!Number.isInteger(setId) || setId < 1) {
    notFound();
  }

  let reading;

  try {
    reading = await aiReading(viewer, slug, setId);
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      notFound();
    }

    if (error instanceof AccessError || error instanceof EngineError) {
      return (
        <>
          <Heading title="Check what was read" />
          <p className="flash bad" role="alert">
            {error.message}
          </p>
        </>
      );
    }

    throw error;
  }

  const failed = one(search, "failed");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(one(search, "date") ?? "") ? one(search, "date")! : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const rows = reading.files.flatMap((file) => file.rows);
  const kept = rows.filter((row) => row.kept).length;

  return (
    <>
      <Heading
        title="2 · Check what was read"
        sub={`${reading.files.length} ${reading.files.length === 1 ? "report" : "reports"} read on ${when(reading.created_at)} by ${reading.created_by}. Untick anything that should not count; only ticked prices are used.`}
      >
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/ai-update`}>
          Back
        </Link>
      </Heading>

      {failed ? (
        <p className="flash bad" role="alert">
          {failed}
        </p>
      ) : null}

      {reading.files.map((file) => (
        <Panel
          key={`${file.id ?? "legacy"}-${file.filename}`}
          title={file.filename}
          hint={file.rows.length ? `${file.rows.filter((row) => row.kept).length} of ${file.rows.length} ticked` : undefined}
          flush={false}
        >
          {file.rows.length ? (
            <div style={{ overflowX: "auto" }}>
              <table className="inputs tight">
                <thead>
                  <tr>
                    {COLUMNS.map((column, index) => (
                      <th key={index}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {file.rows.map((row) => (
                    <RowEditor key={row.id} slug={slug} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No prices were found in this report.</Empty>
          )}
          <AddRow slug={slug} setId={reading.id} fileId={file.id} filename={file.filename} />
        </Panel>
      ))}

      <Panel title="3 · Draft the prices" flush={false}>
        <p className="small muted" style={{ marginTop: 0 }}>
          The AI prices every market of this brand from the {kept} ticked {kept === 1 ? "figure" : "figures"}; then your price rules,
          rounding and currency conversion are applied, and every figure is checked against the reports.
        </p>
        <DraftForm slug={slug} setId={reading.id} date={date} usedAt={reading.used_at} kept={kept} />
      </Panel>
    </>
  );
}
