/**
 * Trade flows: who shipped how much of it to whom, and when.
 *
 * Three tables in the old schema (`globalqties`, `globalimportqties`,
 * `globalexportqties`) over three more (`qtylocations`, `importlocations`,
 * `exportlocations`), identical in shape and maintained in triplicate. One
 * pair here, with a `kind`.
 *
 * Two questions are asked of this data and they want different shapes: "how
 * has the total moved" is a series, and "where did it go last month" is a
 * matrix. Both are here rather than one of them being done in the page.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { sites, tradeLocations, tradeQuantities, type TradeKind } from "@/db/schema";
import { siteScope } from "./scope";

export type TradePlace = {
  id: number;
  site: string;
  site_name: string;
  title: string;
  visible: boolean;
  clicks: number;
  /** Quantity rows of this kind that name it, either end. */
  flows: number;
};

/**
 * The places that took part in flows of one kind.
 *
 * There is one place list per brand and three kinds of flow over it, so
 * which places are an "export place" is a question about the flows, not a
 * column on the place. 146 places came across and only a handful of them
 * appear in exports; listing all 146 on the export screen would be a list
 * of mostly nothing.
 */
export async function tradePlaces(
  siteIds: number[],
  kind: TradeKind,
  query: { site?: string } = {},
  database: Database = db(),
): Promise<TradePlace[]> {
  const only = await siteScope(siteIds, query.site, database);

  const counted = sql<number>`(
    select count(*) from ${tradeQuantities}
    where ${tradeQuantities.kind} = ${kind}
      and (${tradeQuantities.fromLocationId} = ${tradeLocations.id}
        or ${tradeQuantities.toLocationId} = ${tradeLocations.id})
  )`;

  const rows = await database
    .select({ place: tradeLocations, slug: sites.slug, name: sites.name, flows: counted })
    .from(tradeLocations)
    .innerJoin(sites, eq(sites.id, tradeLocations.siteId))
    .where(
      and(
        isNull(tradeLocations.deletedAt),
        only ? inArray(tradeLocations.siteId, only) : undefined,
        sql`${counted} > 0`,
      ),
    )
    .orderBy(asc(sites.slug), asc(tradeLocations.title));

  return rows.map(({ place, slug, name, flows }) => ({
    id: place.id,
    site: slug,
    site_name: name,
    title: place.title,
    visible: place.visible,
    clicks: place.clicks,
    flows: Number(flows),
  }));
}

export type TradePoint = { date: string; total: number; pairs: number };

/**
 * The total moved on each date, oldest first so it reads left to right as a
 * chart. `pairs` is how many location pairs reported that day, which is how
 * a month with half its rows missing becomes visible.
 */
export async function tradeSeries(
  siteIds: number[],
  query: { site?: string; kind: TradeKind; limit?: number },
  database: Database = db(),
): Promise<TradePoint[]> {
  const only = await siteScope(siteIds, query.site, database);
  const limit = Math.min(240, Math.max(1, query.limit ?? 60));

  const rows = await database
    .select({
      date: tradeQuantities.qtyDate,
      total: sql<string>`sum(${tradeQuantities.qty})`,
      pairs: sql<number>`count(*)`,
    })
    .from(tradeQuantities)
    .where(
      and(
        eq(tradeQuantities.kind, query.kind),
        sql`${tradeQuantities.qtyDate} is not null`,
        only ? inArray(tradeQuantities.siteId, only) : undefined,
      ),
    )
    .groupBy(tradeQuantities.qtyDate)
    .orderBy(sql`${tradeQuantities.qtyDate} desc`)
    .limit(limit);

  return rows
    .map((row) => ({
      date: row.date!,
      total: Number(row.total ?? 0),
      pairs: Number(row.pairs),
    }))
    .reverse();
}

export type TradeMatrix = {
  date: string | null;
  columns: string[];
  rows: { from: string; cells: { to: string; qty: number }[]; total: number }[];
  total: number;
};

/**
 * One date laid out as from × to.
 *
 * With no date asked for it takes the newest there is, because that is what
 * the screen opens on and asking the reader to pick a date before showing
 * them anything is how the old screen managed to look empty.
 */
export async function tradeMatrix(
  siteIds: number[],
  query: { site?: string; kind: TradeKind; date?: string },
  database: Database = db(),
): Promise<TradeMatrix> {
  const only = await siteScope(siteIds, query.site, database);

  const scoped = and(
    eq(tradeQuantities.kind, query.kind),
    only ? inArray(tradeQuantities.siteId, only) : undefined,
  );

  let date = query.date ?? null;

  if (!date) {
    const [latest] = await database
      .select({ date: sql<string>`max(${tradeQuantities.qtyDate})` })
      .from(tradeQuantities)
      .where(scoped);

    date = latest?.date ?? null;
  }

  if (!date) {
    return { date: null, columns: [], rows: [], total: 0 };
  }

  const cells = await database
    .select({
      qty: tradeQuantities.qty,
      fromTitle: sql<string>`(select title from ${tradeLocations} where ${tradeLocations.id} = ${tradeQuantities.fromLocationId})`,
      toTitle: sql<string>`(select title from ${tradeLocations} where ${tradeLocations.id} = ${tradeQuantities.toLocationId})`,
    })
    .from(tradeQuantities)
    .where(and(scoped, eq(tradeQuantities.qtyDate, date)));

  const byFrom = new Map<string, Map<string, number>>();
  const columns = new Set<string>();
  let total = 0;

  for (const cell of cells) {
    const fromTitle = cell.fromTitle ?? "unnamed";
    const toTitle = cell.toTitle ?? "unnamed";
    const qty = Number(cell.qty ?? 0);

    columns.add(toTitle);
    total += qty;

    const row = byFrom.get(fromTitle) ?? new Map<string, number>();
    row.set(toTitle, (row.get(toTitle) ?? 0) + qty);
    byFrom.set(fromTitle, row);
  }

  const sortedColumns = [...columns].sort();

  return {
    date,
    columns: sortedColumns,
    rows: [...byFrom.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fromTitle, row]) => ({
        from: fromTitle,
        cells: sortedColumns
          .filter((column) => row.has(column))
          .map((column) => ({ to: column, qty: row.get(column)! })),
        total: [...row.values()].reduce((sum, qty) => sum + qty, 0),
      })),
    total,
  };
}
