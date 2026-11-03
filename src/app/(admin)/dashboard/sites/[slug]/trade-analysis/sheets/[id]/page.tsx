/**
 * One customs sheet: the figures, the AI's reading of them, and the
 * shipments they come from.
 *
 * The figures are on the page as tables so every number the analysis cites
 * can be checked against them — the old screen's point, kept. Every one is
 * SQL's (domain/trade/customs.ts); the model only narrates.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { hasTradeAnalysis } from "@/app/(admin)/nav";
import { AccountError } from "@/domain/accounts/register";
import { customsSheet, shipmentsOf, type Group } from "@/domain/trade/customs";
import { Empty, Heading, Pager, Panel, count, one, pageParam, when, type Search } from "@/app/(admin)/ui";
import { RunCustomsAnalysis } from "../../customs";

export const metadata = { title: "Customs sheet · Petrosil" };
export const dynamic = "force-dynamic";

// Grouped as the analysis writes them (487,648.8), so the two can be read side by side.
const t = (tonnes: number) => tonnes.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const usd = (value: number | null) => (value === null ? "—" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function Breakdown({ title, rows }: { title: string; rows: Group[] }) {
  return (
    <Panel title={title}>
      <table className="tight">
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Shipments</th>
            <th className="num">Tonnes</th>
            <th className="num">Share</th>
            <th className="num">Avg price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name === "Not disclosed" ? <span className="muted">Not disclosed</span> : row.name}</td>
              <td className="num">{count(row.shipments)}</td>
              <td className="num">{t(row.tonnes)}</td>
              <td className="num">{row.share_pct}%</td>
              <td className="num">{usd(row.avg_price_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export default async function CustomsSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const search = await searchParams;

  if (!hasTradeAnalysis(slug) || !/^\d+$/.test(id)) {
    notFound();
  }

  let sheet;
  let shipments;

  try {
    [sheet, shipments] = await Promise.all([
      customsSheet(viewer, slug, Number(id)),
      shipmentsOf(viewer, slug, Number(id), pageParam(one(search, "page"))),
    ]);
  } catch (error) {
    if (error instanceof AccountError && (error.status === 404 || error.status === 403)) {
      notFound();
    }

    throw error;
  }

  const { figures, analysis } = sheet;
  const base = `/dashboard/sites/${slug}/trade-analysis/sheets/${sheet.id}`;

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/trade-analysis`}>
        ← Trade analysis
      </Link>

      <Heading
        title={`${sheet.product} · ${monthName(sheet.month)}`}
        sub={`${sheet.file}${sheet.sheet_name ? ` (sheet “${sheet.sheet_name}”)` : ""} · uploaded ${when(sheet.uploaded_at)} by ${sheet.uploaded_by ?? "unknown"}`}
      >
        {sheet.superseded ? <span className="badge warn">replaced by a newer upload</span> : null}
      </Heading>

      {one(search, "done") ? (
        <p className="flash" role="status">
          {one(search, "done")}
        </p>
      ) : null}

      {sheet.missing_columns.length > 0 ? (
        <p className="small muted">
          This sheet had no {sheet.missing_columns.join(", ")} column{sheet.missing_columns.length === 1 ? "" : "s"}; those details are blank. If
          the vendor renamed a column, the figures that use it will be incomplete.
        </p>
      ) : null}

      <div className="tiles">
        <div className="tile">
          <div className="n">{t(figures.totals.tonnes)}</div>
          <div className="k">tonnes imported</div>
        </div>
        <div className="tile">
          <div className="n">{count(figures.totals.shipments)}</div>
          <div className="k">
            shipments, {figures.totals.first_date ?? "—"} to {figures.totals.last_date ?? "—"}
          </div>
        </div>
        <div className="tile">
          <div className="n">{usd(figures.totals.avg_price_usd)}</div>
          <div className="k">
            average unit price, by volume ({usd(figures.totals.min_price_usd)} to {usd(figures.totals.max_price_usd)})
          </div>
        </div>
        <div className="tile">
          <div className="n">{usd(figures.totals.cif_value_usd)}</div>
          <div className="k">CIF value</div>
        </div>
      </div>

      {figures.totals.without_standard_quantity > 0 ? (
        <p className="small bad">
          {figures.totals.without_standard_quantity} shipment{figures.totals.without_standard_quantity === 1 ? " has" : "s have"} no standard
          quantity and {figures.totals.without_standard_quantity === 1 ? "is" : "are"} not in the tonnage.
        </p>
      ) : null}

      <div id="analysis">
        <Panel
          title="AI analysis"
          flush={false}
          hint={analysis ? `${when(analysis.at)}${analysis.model ? ` · ${analysis.model}` : ""}` : undefined}
          aside={<RunCustomsAnalysis slug={slug} id={sheet.id} again={analysis !== null} />}
        >
          {!analysis ? (
            <p className="muted" style={{ margin: 0 }}>
              The AI writes a market reading of this month for industry readers — who bought, who supplied, how price behaved — from the
              figures on this page. It cites only those figures.
            </p>
          ) : analysis.text ? (
            <p style={{ whiteSpace: "pre-line", maxWidth: "80ch", margin: 0 }}>
              {analysis.text
                .replace(/^#{1,6}\s+/gm, "")
                .split(/\*\*(.+?)\*\*/g)
                .map((part, at) => (at % 2 === 1 ? <strong key={at}>{part}</strong> : part))}
            </p>
          ) : (
            <p className="bad" style={{ margin: 0 }}>
              {analysis.status === "declined"
                ? `The model declined to analyse this sheet.${analysis.error ? ` Reason: ${analysis.error}` : ""}`
                : `The analysis did not complete: ${analysis.error ?? "no reason was given"}.`}
            </p>
          )}
        </Panel>
      </div>

      <div className="split" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))" }}>
        <Breakdown title="Importers" rows={figures.by_importer} />
        <Breakdown title="Suppliers" rows={figures.by_supplier} />
        <Breakdown title="Products" rows={figures.by_product} />
        <Breakdown title="Countries of origin" rows={figures.by_origin_country} />
        <Breakdown title="Indian ports" rows={figures.by_indian_port} />
        <Panel title="Notable shipments">
          <table className="tight">
            <thead>
              <tr>
                <th>Why</th>
                <th>Importer · supplier</th>
                <th className="num">Tonnes</th>
                <th className="num">Price</th>
              </tr>
            </thead>
            <tbody>
              {figures.notable.map((row) => (
                <tr key={row.reason}>
                  <td>
                    {row.reason}
                    <div className="small muted">{row.date}</div>
                  </td>
                  <td>
                    {row.importer ?? "—"}
                    <div className="small muted">{row.supplier}</div>
                  </td>
                  <td className="num">{t(row.tonnes)}</td>
                  <td className="num">{usd(row.price_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title={`${count(shipments.total)} shipments`} hint="As the sheet has them; quantity in the sheet's own unit.">
        <table className="tight">
          <thead>
            <tr>
              <th>Date</th>
              <th>Product</th>
              <th>Importer</th>
              <th>Supplier</th>
              <th>Origin</th>
              <th className="num">Quantity</th>
              <th className="num">Tonnes</th>
              <th className="num">Unit price</th>
            </tr>
          </thead>
          <tbody>
            {shipments.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.shipmentDate}</td>
                <td>
                  {row.productDescription}
                  {row.hsCode ? <div className="small muted">HS {row.hsCode}</div> : null}
                </td>
                <td>{row.importerName ?? "—"}</td>
                <td>{row.supplierName ?? <span className="muted">Not disclosed</span>}</td>
                <td>{row.foreignCountry ?? "—"}</td>
                <td className="num">
                  {Number(row.quantity).toLocaleString("en-IN", { maximumFractionDigits: 3 })} {row.unit ?? ""}
                </td>
                <td className="num">{row.standardQuantity === null ? "—" : t(Number(row.standardQuantity) / 1000)}</td>
                <td className="num">{usd(row.unitPriceUsd === null ? null : Number(row.unitPriceUsd))}</td>
              </tr>
            ))}
            {shipments.rows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Empty>No shipments on this page.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager base={base} here={{}} page={shipments.page} perPage={shipments.per_page} total={shipments.total} />
      </Panel>
    </>
  );
}
