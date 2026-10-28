/**
 * Monthly import and export quantities on the brand sites.
 *
 * The old sites had a country list ("analytics") and, per reporting country,
 * a year of months: each month's total, opening onto the partner countries
 * and their quantities. The page itself sat behind `auth + premium`.
 *
 * Here the paywall is the estate's one rule — movement and names are public,
 * figures are paid for. Anyone sees which countries report, which months are
 * on record and how many partners each month names; only a paying reader
 * gets the quantities. The old list printed the latest quantity to everyone,
 * which was the only figure on the old site a visitor could read; it is held
 * back with the rest.
 *
 * A reporting country is one the brand shows (`visible`) that has figures as
 * the reporting end: the exporter of an export, the importer of an import.
 * The carried "qty" set (the old `globalqties`, dead since 2022) is not
 * served. Quantities are in metric tonnes, as the old pages printed them.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db, type Database } from "@/db";
import { tradeLocations, tradeQuantities } from "@/db/schema";
import { SHEET_KINDS, type SheetKind } from "@/domain/trade/sheets";
import type { Entitlement } from "./paywall";
import { refusalFor, type Refusal } from "./reports";

const reportingEnd = (kind: SheetKind) =>
  kind === "export" ? tradeQuantities.fromLocationId : tradeQuantities.toLocationId;
const partnerEnd = (kind: SheetKind) =>
  kind === "export" ? tradeQuantities.toLocationId : tradeQuantities.fromLocationId;

export const isTradeKind = (value: string): value is SheetKind => (SHEET_KINDS as readonly string[]).includes(value);

/** Figures are for paying readers: the same refusal a premium report gives. */
const lockFor = (entitlement: Entitlement): Refusal | null => refusalFor({ status: "premium" }, entitlement);

export type TradeCountry = {
  id: number;
  title: string;
  /** Per kind: months on record and the latest; absent when it reports none of that kind. */
  import: { months: number; latest_month: string } | null;
  export: { months: number; latest_month: string } | null;
};

const visibleOn = (siteId: number) =>
  and(eq(tradeLocations.siteId, siteId), eq(tradeLocations.visible, true), isNull(tradeLocations.deletedAt));

/** The countries that report, with what they report. Names and dates only: nothing here is a figure. */
export async function tradeCountries(siteId: number, database: Database = db()): Promise<TradeCountry[]> {
  const byId = new Map<number, TradeCountry>();

  for (const kind of SHEET_KINDS) {
    const rows = await database
      .select({
        id: tradeLocations.id,
        title: tradeLocations.title,
        months: sql<number>`count(distinct ${tradeQuantities.qtyDate})`,
        latest: sql<string>`max(${tradeQuantities.qtyDate})`,
      })
      .from(tradeQuantities)
      .innerJoin(tradeLocations, eq(tradeLocations.id, reportingEnd(kind)))
      .where(and(eq(tradeQuantities.siteId, siteId), eq(tradeQuantities.kind, kind), visibleOn(siteId), sql`${tradeQuantities.qtyDate} is not null`, sql`${tradeQuantities.qty} is not null`))
      .groupBy(tradeLocations.id, tradeLocations.title);

    for (const row of rows) {
      const country = byId.get(row.id) ?? { id: row.id, title: row.title, import: null, export: null };

      country[kind] = { months: Number(row.months), latest_month: String(row.latest).slice(0, 7) };
      byId.set(row.id, country);
    }
  }

  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export type TradeMonth = {
  /** YYYY-MM. */
  month: string;
  partners: number;
  /** Tonnes; null when this reader may not see figures. */
  total: number | null;
  /** Each partner and its quantity, largest first; empty when this reader may not see figures. */
  flows: { country: string; qty: number }[];
};

export type TradeYear = {
  country: { id: number; title: string };
  kind: SheetKind;
  unit: "MT";
  /** Years on record, newest first. */
  years: number[];
  year: number;
  /** Newest month first. */
  months: TradeMonth[];
  figures: { allowed: boolean; reason: Refusal | null };
};

/**
 * One reporting country's year of one kind. The year defaults to the latest
 * on record (the old page defaulted to the calendar year, which is empty for
 * months after New Year). Null for a country this brand does not show or
 * that reports nothing of this kind. Counted as one look at the country.
 */
export async function tradeYear(
  siteId: number,
  input: { location: number; kind: SheetKind; year?: number },
  entitlement: Entitlement,
  database: Database = db(),
): Promise<TradeYear | null> {
  const [place] = await database
    .select({ id: tradeLocations.id, title: tradeLocations.title })
    .from(tradeLocations)
    .where(and(visibleOn(siteId), eq(tradeLocations.id, input.location)))
    .limit(1);

  if (!place) {
    return null;
  }

  const ofCountry = and(
    eq(tradeQuantities.siteId, siteId),
    eq(tradeQuantities.kind, input.kind),
    eq(reportingEnd(input.kind), place.id),
    sql`${tradeQuantities.qtyDate} is not null`,
    sql`${tradeQuantities.qty} is not null`,
  );

  const years = (
    await database
      .select({ year: sql<number>`extract(year from ${tradeQuantities.qtyDate})::int` })
      .from(tradeQuantities)
      .where(ofCountry)
      .groupBy(sql`1`)
      .orderBy(desc(sql`1`))
  ).map((row) => Number(row.year));

  if (years.length === 0) {
    return null;
  }

  const year = input.year && years.includes(input.year) ? input.year : years[0]!;
  const lock = lockFor(entitlement);
  const partner = alias(tradeLocations, "partner");

  const rows = await database
    .select({ date: tradeQuantities.qtyDate, qty: tradeQuantities.qty, country: partner.title })
    .from(tradeQuantities)
    .innerJoin(partner, eq(partner.id, partnerEnd(input.kind)))
    .where(and(ofCountry, sql`extract(year from ${tradeQuantities.qtyDate}) = ${year}`))
    .orderBy(desc(tradeQuantities.qtyDate), desc(tradeQuantities.qty));

  const months = new Map<string, TradeMonth>();

  for (const row of rows) {
    const key = String(row.date).slice(0, 7);
    const month = months.get(key) ?? { month: key, partners: 0, total: lock ? null : 0, flows: [] };

    month.partners++;

    if (!lock) {
      const qty = Number(row.qty);

      month.total = Math.round((month.total! + qty) * 1000) / 1000;
      month.flows.push({ country: row.country, qty });
    }

    months.set(key, month);
  }

  try {
    await database
      .update(tradeLocations)
      .set({ clicks: sql`${tradeLocations.clicks} + 1` })
      .where(eq(tradeLocations.id, place.id));
  } catch (error) {
    console.error("could not count a trade country view", { id: place.id, error });
  }

  return {
    country: place,
    kind: input.kind,
    unit: "MT",
    years,
    year,
    months: [...months.values()],
    figures: { allowed: lock === null, reason: lock },
  };
}
