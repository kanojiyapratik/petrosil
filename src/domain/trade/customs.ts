/**
 * Customs sheets: one month of Indian customs import data for one product,
 * the figures behind it, and an AI analysis of those figures — baseoil's old
 * "Trade analysis" (customs sheets, read by AI).
 *
 * That screen called a separate service which never reached production; its
 * rules are kept here:
 *
 *  - Every number is SQL's. The model is handed the figures and narrates
 *    them; it never counts rows. Models miscount.
 *  - Quantities are summed from `standard_quantity` (kilograms), never from
 *    `quantity`, which mixes tonnes and kilograms in one sheet — summing it
 *    is wrong by a factor of a thousand.
 *  - Prices are volume-weighted: a 1.75 t sample lot must not count for as
 *    much as a 19,000 t cargo.
 *  - A missing name is "Not disclosed", one group, not dropped: undisclosed
 *    suppliers can be a large share of the volume, and that is the story.
 *
 * Uploading the same product and month again replaces the current sheet; the
 * old one is kept, marked superseded. Postgres enforces one current sheet
 * per product and month with a partial unique index.
 *
 * Who may: `trade-analysis-view`, the one permission the old screens had.
 */

import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, sites, tradeImports, tradeShipments, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { EngineError, engine } from "@/lib/engine/client";

import { CustomsSheetError, readCustomsSheet } from "./customs-sheet";

const PERMISSION = "trade-analysis-view";
/** Groups shown per breakdown; the rest are summed into one "All others" line. */
const TOP = 15;
const ANALYSIS_TIMEOUT = 120_000;

type Context = { ip?: string | null };

async function brandFor(guard: Guarded, slug: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, PERMISSION, database);

  return brand;
}

/* ----------------------------------------------------------- uploading */

export async function uploadCustomsSheet(
  guard: Guarded,
  slug: string,
  input: { productLabel: string; periodMonth: string; file: { name: string; bytes: Buffer } },
  context: Context = {},
  database: Database = db(),
): Promise<{ id: number; shipments: number; skipped: number; missingColumns: string[]; replaced: boolean }> {
  const brand = await brandFor(guard, slug, database);
  const productLabel = input.productLabel.replace(/\s+/g, " ").trim().slice(0, 120);

  if (productLabel === "") {
    throw new AccountError("Name the product the sheet is for, e.g. Petroleum Coke.", 422, "product_label");
  }

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodMonth)) {
    throw new AccountError("Choose the month the sheet covers.", 422, "period_month");
  }

  // Read before anything is written: a bad sheet never leaves half an import.
  let sheet;

  try {
    sheet = await readCustomsSheet(input.file.name, input.file.bytes);
  } catch (error) {
    if (error instanceof CustomsSheetError) {
      throw new AccountError(error.message, 422, "sheet");
    }

    throw error;
  }

  const periodMonth = `${input.periodMonth}-01`;

  const result = await database.transaction(async (tx) => {
    const replaced = await tx
      .update(tradeImports)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(tradeImports.siteId, brand.id),
          sql`lower(${tradeImports.productLabel}) = ${productLabel.toLowerCase()}`,
          eq(tradeImports.periodMonth, periodMonth),
          isNull(tradeImports.supersededAt),
        ),
      )
      .returning({ id: tradeImports.id });

    const [made] = await tx
      .insert(tradeImports)
      .values({
        siteId: brand.id,
        productLabel,
        periodMonth,
        sourceFilename: input.file.name.slice(0, 191),
        sheetName: sheet.sheetName,
        rowCount: sheet.shipments.length,
        skippedRows: sheet.skipped,
        missingColumns: sheet.missingColumns,
        uploadedBy: guard.identity.user.id,
      })
      .returning();

    for (let at = 0; at < sheet.shipments.length; at += 1000) {
      await tx.insert(tradeShipments).values(sheet.shipments.slice(at, at + 1000).map((row) => ({ ...row, importId: made!.id })));
    }

    await tx.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "trade.import",
      entity: "trade_import",
      entityId: made!.id,
      detail: { product: productLabel, month: input.periodMonth, shipments: sheet.shipments.length, replaced: replaced.map((row) => row.id) },
      ip: context.ip ?? null,
    });

    return { id: made!.id, replaced: replaced.length > 0 };
  });

  return { ...result, shipments: sheet.shipments.length, skipped: sheet.skipped, missingColumns: sheet.missingColumns };
}

/* -------------------------------------------------------------- reading */

export type SheetRow = {
  id: number;
  product: string;
  month: string;
  file: string;
  shipments: number;
  uploaded_at: string;
  uploaded_by: string | null;
  superseded: boolean;
  analysis: string | null;
};

export async function listCustomsSheets(guard: Guarded, slug: string, database: Database = db()): Promise<SheetRow[]> {
  const brand = await brandFor(guard, slug, database);
  const rows = await database
    .select({ sheet: tradeImports, by: users.name })
    .from(tradeImports)
    .leftJoin(users, eq(users.id, tradeImports.uploadedBy))
    .where(eq(tradeImports.siteId, brand.id))
    .orderBy(desc(tradeImports.periodMonth), desc(tradeImports.id))
    .limit(100);

  return rows.map(({ sheet, by }) => ({
    id: sheet.id,
    product: sheet.productLabel,
    month: sheet.periodMonth.slice(0, 7),
    file: sheet.sourceFilename,
    shipments: sheet.rowCount,
    uploaded_at: sheet.createdAt.toISOString(),
    uploaded_by: by,
    superseded: sheet.supersededAt !== null,
    analysis: sheet.analysisStatus,
  }));
}

export type Group = { name: string; shipments: number; tonnes: number; share_pct: number; avg_price_usd: number | null };

export type Figures = {
  product: string;
  month: string;
  totals: {
    shipments: number;
    tonnes: number;
    cif_value_usd: number;
    avg_price_usd: number | null;
    min_price_usd: number | null;
    max_price_usd: number | null;
    first_date: string | null;
    last_date: string | null;
    /** Shipments with no standard quantity: they cannot count towards tonnes. */
    without_standard_quantity: number;
  };
  by_importer: Group[];
  by_supplier: Group[];
  by_product: Group[];
  by_origin_country: Group[];
  by_indian_port: Group[];
  notable: { reason: string; importer: string | null; supplier: string; tonnes: number; price_usd: number | null; date: string }[];
};

const n = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const maybe = (value: unknown) => (value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100);
const tonnes = (kg: unknown) => Math.round(n(kg)) / 1000;

async function grouped(importId: number, column: string, totalKg: number, database: Database): Promise<Group[]> {
  const rows = (await database.execute(sql`
    select coalesce(nullif(trim(${sql.identifier(column)}), ''), 'Not disclosed') as name,
           count(*)::int as shipments,
           coalesce(sum(standard_quantity), 0) as kg,
           sum(unit_price_usd * standard_quantity) / nullif(sum(standard_quantity) filter (where unit_price_usd is not null), 0) as avg_price
      from trade_shipments
     where import_id = ${importId}
     group by 1
     order by kg desc, name
  `)) as unknown as { name: string; shipments: number; kg: string; avg_price: string | null }[];

  const shown = rows.slice(0, TOP);
  const rest = rows.slice(TOP);
  const group = (name: string, shipments: number, kg: number, avg: number | null): Group => ({
    name,
    shipments,
    tonnes: tonnes(kg),
    share_pct: totalKg > 0 ? Math.round((kg / totalKg) * 1000) / 10 : 0,
    avg_price_usd: avg === null ? null : Math.round(avg * 100) / 100,
  });

  const out = shown.map((row) => group(row.name, row.shipments, n(row.kg), row.avg_price === null ? null : Number(row.avg_price)));

  if (rest.length > 0) {
    // Summed here only to label the tail; every figure in it is SQL's.
    out.push(
      group(
        `All others (${rest.length})`,
        rest.reduce((sum, row) => sum + row.shipments, 0),
        rest.reduce((sum, row) => sum + n(row.kg), 0),
        null,
      ),
    );
  }

  return out;
}

async function sheetOf(guard: Guarded, slug: string, id: number, database: Database) {
  const brand = await brandFor(guard, slug, database);
  const [found] = await database
    .select({ sheet: tradeImports, by: users.name })
    .from(tradeImports)
    .leftJoin(users, eq(users.id, tradeImports.uploadedBy))
    .where(and(eq(tradeImports.id, id), eq(tradeImports.siteId, brand.id)))
    .limit(1);

  if (!found) {
    throw new AccountError("No such customs sheet on this brand.", 404, "sheet");
  }

  return { brand, ...found };
}

export async function figuresFor(importId: number, product: string, month: string, database: Database = db()): Promise<Figures> {
  const [totals] = (await database.execute(sql`
    select count(*)::int as shipments,
           coalesce(sum(standard_quantity), 0) as kg,
           coalesce(sum(cif_value_usd), 0) as cif,
           sum(unit_price_usd * standard_quantity) / nullif(sum(standard_quantity) filter (where unit_price_usd is not null), 0) as avg_price,
           min(unit_price_usd) as min_price,
           max(unit_price_usd) as max_price,
           min(shipment_date)::text as first_date,
           max(shipment_date)::text as last_date,
           (count(*) filter (where standard_quantity is null))::int as without_sq
      from trade_shipments
     where import_id = ${importId}
  `)) as unknown as {
    shipments: number;
    kg: string;
    cif: string;
    avg_price: string | null;
    min_price: string | null;
    max_price: string | null;
    first_date: string | null;
    last_date: string | null;
    without_sq: number;
  }[];

  const totalKg = n(totals?.kg);

  const [byImporter, bySupplier, byProduct, byOrigin, byPort, notable] = await Promise.all([
    grouped(importId, "importer_name", totalKg, database),
    grouped(importId, "supplier_name", totalKg, database),
    grouped(importId, "product_description", totalKg, database),
    grouped(importId, "foreign_country", totalKg, database),
    grouped(importId, "indian_port", totalKg, database),
    database.execute(sql`
      (select 'largest shipment' as reason, importer_name, supplier_name, standard_quantity, unit_price_usd, shipment_date::text as date
         from trade_shipments where import_id = ${importId} and standard_quantity is not null order by standard_quantity desc, id limit 1)
      union all
      (select 'highest unit price', importer_name, supplier_name, standard_quantity, unit_price_usd, shipment_date::text
         from trade_shipments where import_id = ${importId} and unit_price_usd is not null order by unit_price_usd desc, id limit 1)
      union all
      (select 'lowest unit price', importer_name, supplier_name, standard_quantity, unit_price_usd, shipment_date::text
         from trade_shipments where import_id = ${importId} and unit_price_usd is not null order by unit_price_usd asc, id limit 1)
    `) as unknown as Promise<
      { reason: string; importer_name: string | null; supplier_name: string | null; standard_quantity: string | null; unit_price_usd: string | null; date: string }[]
    >,
  ]);

  return {
    product,
    month,
    totals: {
      shipments: totals?.shipments ?? 0,
      tonnes: tonnes(totalKg),
      cif_value_usd: maybe(totals?.cif) ?? 0,
      avg_price_usd: maybe(totals?.avg_price),
      min_price_usd: maybe(totals?.min_price),
      max_price_usd: maybe(totals?.max_price),
      first_date: totals?.first_date ?? null,
      last_date: totals?.last_date ?? null,
      without_standard_quantity: totals?.without_sq ?? 0,
    },
    by_importer: byImporter,
    by_supplier: bySupplier,
    by_product: byProduct,
    by_origin_country: byOrigin,
    by_indian_port: byPort,
    notable: notable.map((row) => ({
      reason: row.reason,
      importer: row.importer_name,
      supplier: row.supplier_name ?? "Not disclosed",
      tonnes: tonnes(row.standard_quantity),
      price_usd: maybe(row.unit_price_usd),
      date: row.date,
    })),
  };
}

export type SheetDetail = {
  id: number;
  product: string;
  month: string;
  file: string;
  sheet_name: string | null;
  skipped: number;
  missing_columns: string[];
  uploaded_at: string;
  uploaded_by: string | null;
  superseded: boolean;
  figures: Figures;
  analysis: { status: string; text: string | null; model: string | null; error: string | null; at: string } | null;
};

export async function customsSheet(guard: Guarded, slug: string, id: number, database: Database = db()): Promise<SheetDetail> {
  const { sheet, by } = await sheetOf(guard, slug, id, database);
  const month = sheet.periodMonth.slice(0, 7);

  return {
    id: sheet.id,
    product: sheet.productLabel,
    month,
    file: sheet.sourceFilename,
    sheet_name: sheet.sheetName,
    skipped: sheet.skippedRows,
    missing_columns: sheet.missingColumns ?? [],
    uploaded_at: sheet.createdAt.toISOString(),
    uploaded_by: by,
    superseded: sheet.supersededAt !== null,
    figures: await figuresFor(sheet.id, sheet.productLabel, month, database),
    analysis:
      sheet.analysisStatus && sheet.analysisAt
        ? {
            status: sheet.analysisStatus,
            text: sheet.analysisText,
            model: sheet.analysisModel,
            error: sheet.analysisError,
            at: sheet.analysisAt.toISOString(),
          }
        : null,
  };
}

export type ShipmentRow = typeof tradeShipments.$inferSelect;

export async function shipmentsOf(
  guard: Guarded,
  slug: string,
  id: number,
  page = 1,
  database: Database = db(),
): Promise<{ rows: Omit<ShipmentRow, "raw">[]; total: number; page: number; per_page: number }> {
  const { sheet } = await sheetOf(guard, slug, id, database);
  const perPage = 50;
  const at = Math.max(1, Math.trunc(page));
  const { raw, ...columns } = getTableColumns(tradeShipments);

  void raw;

  const rows = await database
    .select(columns)
    .from(tradeShipments)
    .where(eq(tradeShipments.importId, sheet.id))
    .orderBy(tradeShipments.shipmentDate, tradeShipments.id)
    .limit(perPage)
    .offset((at - 1) * perPage);

  return { rows, total: sheet.rowCount, page: at, per_page: perPage };
}

/* ------------------------------------------------------------- analysis */

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** The AI's reading of the figures. A failure is kept and shown like a result. */
export async function analyseCustomsSheet(
  guard: Guarded,
  slug: string,
  id: number,
  context: Context = {},
  database: Database = db(),
): Promise<{ status: string; error: string | null }> {
  const { brand, sheet } = await sheetOf(guard, slug, id, database);
  const month = sheet.periodMonth.slice(0, 7);
  const figures = await figuresFor(sheet.id, sheet.productLabel, month, database);
  let outcome: { status: string; output_markdown: string | null; model: string | null; error: string | null };

  try {
    outcome = (
      await engine<{ analysis: typeof outcome }>(brand.slug, "trade-analysis", {
        method: "POST",
        actor: guard.identity.user.email,
        timeout: ANALYSIS_TIMEOUT,
        json: { title: `${sheet.productLabel} imports into India — ${monthName(month)}`, figures },
      })
    ).analysis;
  } catch (error) {
    if (!(error instanceof EngineError)) {
      throw error;
    }

    outcome = { status: "failed", output_markdown: null, model: null, error: error.message };
  }

  await database
    .update(tradeImports)
    .set({
      analysisStatus: outcome.status.slice(0, 24),
      analysisText: outcome.output_markdown?.trim() || null,
      analysisModel: outcome.model?.slice(0, 120) ?? null,
      analysisError: outcome.error,
      analysisAt: new Date(),
      analysisBy: guard.identity.user.id,
    })
    .where(eq(tradeImports.id, sheet.id));

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "trade.analyse",
    entity: "trade_import",
    entityId: sheet.id,
    detail: { status: outcome.status, model: outcome.model },
    ip: context.ip ?? null,
  });

  return { status: outcome.status, error: outcome.error };
}
