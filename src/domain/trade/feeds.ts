/**
 * Trade feeds: monthly import and export sheets filled from government
 * statistics instead of by hand.
 *
 * A feed names a sheet (a brand's reporting country and a direction), the
 * source that publishes it and the product codes that add up to the brand's
 * product. The engine asks which months each feed is missing, reads them,
 * and reports back; each month it found is staged here as an update, with
 * every partner matched to one of the brand's places where it can be. A
 * person publishes it — or, for a feed set to, the engine's own report does
 * when every partner matched — and the brand's model then writes a market
 * insight from figures worked out here.
 *
 * Figures are the source's divided by a thousand and rounded, which is what
 * reproduces the hand-entered history (Thailand's 31,106,885 litres of base
 * oil from Singapore in April 2026 is baseoil's 31,107).
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  auditLog,
  sites,
  tradeFeeds,
  tradeLocationAliases,
  tradeLocations,
  tradeQuantities,
  tradeUpdates,
  TRADE_SOURCES,
  type TradeSource,
  type TradeUpdateRow,
} from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { EngineError, engine } from "@/lib/engine/client";
import { countryCode, countryName, normaliseName } from "./countries";

type Context = { ip?: string | null };
type FeedKind = "import" | "export";

export const SOURCE_LABELS: Record<TradeSource, string> = {
  thailand: "Thai Customs (customs.go.th)",
  japan: "Japan Ministry of Finance (e-Stat)",
  india: "India DGCI&S (TradeStat)",
  singapore: "Singapore SingStat (Enterprise Singapore)",
  korea: "Korea Customs Service (data.go.kr key)",
  comtrade: "UN Comtrade (six-digit, later)",
};

/** The reporting country each national source speaks for. */
export const SOURCE_COUNTRY: Partial<Record<TradeSource, string>> = {
  thailand: "TH",
  japan: "JP",
  india: "IN",
  singapore: "SG",
  korea: "KR",
};

/** How many missing months one pass may ask for, per feed. */
const MAX_MONTHS = 6;
const INSIGHT_TIMEOUT = 120_000;

/* ----------------------------------------------------------- access */

async function brandOf(guard: Guarded, slug: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "trade-qty-edit", database);

  return brand;
}

const monthOf = (date: string) => date.slice(0, 7);
const firstOf = (month: string) => `${month}-01`;

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));

  return d.toISOString().slice(0, 7);
}

export function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "27101941000, 27101946000" or one per line → distinct digit strings. */
export function parseCodes(text: unknown): string[] {
  const codes = String(text ?? "")
    .split(/[\s,;]+/)
    .map((code) => code.replace(/[.\s]/g, ""))
    .filter(Boolean);

  for (const code of codes) {
    if (!/^\d{4,11}$/.test(code)) {
      throw new AccountError(`"${code}" is not a product code: use the digits only, like 27101941.`, 422, "hs_codes");
    }
  }

  if (codes.length === 0) {
    throw new AccountError("Give at least one product code.", 422, "hs_codes");
  }

  return [...new Set(codes)].slice(0, 20);
}

/* ------------------------------------------------------------ feeds */

export type FeedRow = {
  id: number;
  location_id: number;
  reporter: string;
  kind: FeedKind;
  source: TradeSource;
  source_label: string;
  hs_codes: string[];
  product: string;
  enabled: boolean;
  auto_publish: boolean;
  last_checked_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  latest_month: string | null;
};

/** The latest month each of the brand's sheets holds a figure for. */
async function latestMonths(siteId: number, database: Database): Promise<Map<string, string>> {
  const rows = await database.execute<{ kind: string; place: number; latest: string }>(sql`
    select kind,
           case when kind = 'export' then from_location_id else to_location_id end as place,
           max(qty_date)::text as latest
      from trade_quantities
     where site_id = ${siteId} and kind in ('import', 'export') and qty is not null
     group by 1, 2`);

  return new Map(rows.map((row) => [`${row.kind}:${row.place}`, row.latest]));
}

export async function listFeeds(guard: Guarded, slug: string, database: Database = db()) {
  const brand = await brandOf(guard, slug, database);
  const [feeds, latest, places, updates] = await Promise.all([
    database
      .select({ feed: tradeFeeds, reporter: tradeLocations.title })
      .from(tradeFeeds)
      .innerJoin(tradeLocations, eq(tradeLocations.id, tradeFeeds.locationId))
      .where(eq(tradeFeeds.siteId, brand.id))
      .orderBy(tradeLocations.title, tradeFeeds.kind),
    latestMonths(brand.id, database),
    database
      .select({ id: tradeLocations.id, title: tradeLocations.title })
      .from(tradeLocations)
      .where(and(eq(tradeLocations.siteId, brand.id), isNull(tradeLocations.deletedAt)))
      .orderBy(tradeLocations.title),
    database
      .select({
        id: tradeUpdates.id,
        feedId: tradeUpdates.feedId,
        qtyDate: tradeUpdates.qtyDate,
        status: tradeUpdates.status,
        rows: tradeUpdates.rows,
        fetchedAt: tradeUpdates.fetchedAt,
        decidedAt: tradeUpdates.decidedAt,
        insightStatus: tradeUpdates.insightStatus,
      })
      .from(tradeUpdates)
      .where(eq(tradeUpdates.siteId, brand.id))
      .orderBy(desc(tradeUpdates.id))
      .limit(60),
  ]);

  const rows: FeedRow[] = feeds.map(({ feed, reporter }) => ({
    id: feed.id,
    location_id: feed.locationId,
    reporter,
    kind: feed.kind,
    source: feed.source,
    source_label: SOURCE_LABELS[feed.source] ?? feed.source,
    hs_codes: feed.hsCodes,
    product: feed.product,
    enabled: feed.enabled,
    auto_publish: feed.autoPublish,
    last_checked_at: feed.lastCheckedAt,
    last_status: feed.lastStatus,
    last_error: feed.lastError,
    latest_month: latest.get(`${feed.kind}:${feed.locationId}`)?.slice(0, 7) ?? null,
  }));

  const byFeed = new Map(rows.map((row) => [row.id, row]));

  return {
    brand,
    feeds: rows,
    places,
    updates: updates.map((update) => ({
      id: update.id,
      feed: byFeed.get(update.feedId) ?? null,
      month: monthOf(update.qtyDate),
      status: update.status,
      partners: update.rows.length,
      unmatched: update.rows.filter((row) => row.locationId === null && !row.skipped).length,
      total: update.rows.reduce((sum, row) => sum + Number(row.qty), 0),
      fetched_at: update.fetchedAt,
      decided_at: update.decidedAt,
      insight: update.insightStatus,
    })),
  };
}

export async function saveFeed(
  guard: Guarded,
  input: {
    site: string;
    id?: unknown;
    location: unknown;
    kind: unknown;
    source: unknown;
    hs_codes: unknown;
    product: unknown;
    auto_publish?: unknown;
  },
  context: Context = {},
  database: Database = db(),
): Promise<{ id: number }> {
  const brand = await brandOf(guard, input.site, database);
  const kind = String(input.kind);

  if (kind !== "import" && kind !== "export") {
    throw new AccountError("Choose imports or exports.", 422, "kind");
  }

  const source = String(input.source) as TradeSource;

  if (!(TRADE_SOURCES as readonly string[]).includes(source)) {
    throw new AccountError("Choose one of the sources.", 422, "source");
  }

  const [place] = await database
    .select()
    .from(tradeLocations)
    .where(and(eq(tradeLocations.id, Number(input.location)), eq(tradeLocations.siteId, brand.id), isNull(tradeLocations.deletedAt)))
    .limit(1);

  if (!place) {
    throw new AccountError("Choose the reporting country from this brand's countries.", 422, "location");
  }

  const product = String(input.product ?? "").trim().replace(/\s+/g, " ").slice(0, 120);

  if (!product) {
    throw new AccountError("Say what the codes are, like Lubricating base oil.", 422, "product");
  }

  const values = {
    siteId: brand.id,
    locationId: place.id,
    kind: kind as FeedKind,
    source,
    hsCodes: parseCodes(input.hs_codes),
    product,
    autoPublish: input.auto_publish === true || input.auto_publish === "on" || input.auto_publish === "1",
  };

  const id = input.id ? Number(input.id) : null;
  const [clash] = await database
    .select({ id: tradeFeeds.id })
    .from(tradeFeeds)
    .where(and(eq(tradeFeeds.siteId, brand.id), eq(tradeFeeds.locationId, place.id), eq(tradeFeeds.kind, values.kind)))
    .limit(1);

  if (clash && clash.id !== id) {
    throw new AccountError(`${place.title}'s ${kind}s already have a feed. Edit that one instead.`, 409, "location");
  }

  let saved: number;

  if (id) {
    const [row] = await database
      .update(tradeFeeds)
      .set(values)
      .where(and(eq(tradeFeeds.id, id), eq(tradeFeeds.siteId, brand.id)))
      .returning({ id: tradeFeeds.id });

    if (!row) {
      throw new AccountError("That feed could not be found.", 404, "id");
    }

    saved = row.id;
  } else {
    const [row] = await database
      .insert(tradeFeeds)
      .values({ ...values, createdBy: guard.identity.user.id })
      .returning({ id: tradeFeeds.id });
    saved = row!.id;
  }

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: id ? "trade.feed.update" : "trade.feed.create",
    entity: "trade_feed",
    entityId: saved,
    detail: { reporter: place.title, kind, source, codes: values.hsCodes, product },
    ip: context.ip ?? null,
  });

  return { id: saved };
}

export async function switchFeed(
  guard: Guarded,
  input: { site: string; id: unknown; enabled: boolean },
  context: Context = {},
  database: Database = db(),
) {
  const brand = await brandOf(guard, input.site, database);
  const [row] = await database
    .update(tradeFeeds)
    .set({ enabled: input.enabled })
    .where(and(eq(tradeFeeds.id, Number(input.id)), eq(tradeFeeds.siteId, brand.id)))
    .returning({ id: tradeFeeds.id });

  if (!row) {
    throw new AccountError("That feed could not be found.", 404, "id");
  }

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: input.enabled ? "trade.feed.on" : "trade.feed.off",
    entity: "trade_feed",
    entityId: row.id,
    detail: {},
    ip: context.ip ?? null,
  });
}

export async function removeFeed(guard: Guarded, input: { site: string; id: unknown }, context: Context = {}, database: Database = db()) {
  const brand = await brandOf(guard, input.site, database);
  const [row] = await database
    .delete(tradeFeeds)
    .where(and(eq(tradeFeeds.id, Number(input.id)), eq(tradeFeeds.siteId, brand.id)))
    .returning({ id: tradeFeeds.id, product: tradeFeeds.product });

  if (!row) {
    throw new AccountError("That feed could not be found.", 404, "id");
  }

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "trade.feed.remove",
    entity: "trade_feed",
    entityId: row.id,
    detail: { product: row.product },
    ip: context.ip ?? null,
  });
}

/* ------------------------------------------------- the engine's side */

/**
 * What the engine should fetch: every enabled feed with the months after
 * the latest its sheet holds, up to last month (a month in progress is never
 * published), at most six at a time. A sheet with nothing yet starts three
 * months back. A month already staged and waiting is not asked for again.
 */
export async function feedsDue(siteId: number, today = new Date(), database: Database = db()) {
  const feeds = await database
    .select({ feed: tradeFeeds, reporter: tradeLocations.title })
    .from(tradeFeeds)
    .innerJoin(tradeLocations, eq(tradeLocations.id, tradeFeeds.locationId))
    .where(and(eq(tradeFeeds.siteId, siteId), eq(tradeFeeds.enabled, true)));

  if (feeds.length === 0) {
    return [];
  }

  const latest = await latestMonths(siteId, database);
  const pending = await database
    .select({ feedId: tradeUpdates.feedId, qtyDate: tradeUpdates.qtyDate })
    .from(tradeUpdates)
    .where(and(eq(tradeUpdates.siteId, siteId), eq(tradeUpdates.status, "pending")));
  const waiting = new Set(pending.map((row) => `${row.feedId}:${monthOf(row.qtyDate)}`));
  const lastMonth = addMonths(today.toISOString().slice(0, 7), -1);

  return feeds.map(({ feed, reporter }) => {
    const held = latest.get(`${feed.kind}:${feed.locationId}`)?.slice(0, 7);
    const months: string[] = [];

    for (let month = held ? addMonths(held, 1) : addMonths(lastMonth, -2); month <= lastMonth && months.length < MAX_MONTHS; month = addMonths(month, 1)) {
      if (!waiting.has(`${feed.id}:${month}`)) {
        months.push(month);
      }
    }

    return {
      id: feed.id,
      source: feed.source,
      kind: feed.kind,
      hs_codes: feed.hsCodes,
      product: feed.product,
      reporter,
      reporter_iso2: SOURCE_COUNTRY[feed.source] ?? countryCode(reporter.replace(/^India('s)?\b.*/i, "India")),
      months,
    };
  });
}

/** Matches a source's partner name to one of the brand's places. */
export class PartnerResolver {
  private constructor(
    private readonly byAlias: Map<string, number>,
    /** Every place for a country, the most used first. */
    private readonly byCode: Map<string, number[]>,
  ) {}

  static async forSite(siteId: number, database: Database = db()): Promise<PartnerResolver> {
    const [places, aliases, usage] = await Promise.all([
      database
        .select({ id: tradeLocations.id, title: tradeLocations.title })
        .from(tradeLocations)
        .where(and(eq(tradeLocations.siteId, siteId), isNull(tradeLocations.deletedAt))),
      database
        .select({ alias: tradeLocationAliases.alias, locationId: tradeLocationAliases.locationId })
        .from(tradeLocationAliases)
        .where(eq(tradeLocationAliases.siteId, siteId)),
      database.execute<{ place: number; uses: number }>(sql`
        select place, count(*)::int as uses from (
          select from_location_id as place from trade_quantities where site_id = ${siteId}
          union all
          select to_location_id from trade_quantities where site_id = ${siteId}) t
         group by place`),
    ]);

    const uses = new Map(usage.map((row) => [row.place, row.uses]));
    const byAlias = new Map<string, number>();
    const byCode = new Map<string, number[]>();

    // Two places can share a country ("Turkey" and "Republic of Turkiye"
    // on baseoil, "Laos" and "Lao Republic" on bitumart). The sheet being
    // filled decides when it has used one (see resolve); otherwise the one
    // the brand's sheets use most.
    for (const place of [...places].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0))) {
      if (!byAlias.has(normaliseName(place.title))) {
        byAlias.set(normaliseName(place.title), place.id);
      }

      const code = countryCode(place.title);

      if (code) {
        byCode.set(code, [...(byCode.get(code) ?? []), place.id]);
      }
    }

    for (const alias of aliases) {
      byAlias.set(normaliseName(alias.alias), alias.locationId);
    }

    return new PartnerResolver(byAlias, byCode);
  }

  /** `onSheet`: the places this sheet has used before, which win a tie. */
  resolve(partner: string, iso2: string | null, onSheet: Set<number> = new Set()): number | null {
    const learnt = this.byAlias.get(normaliseName(partner));

    if (learnt) {
      return learnt;
    }

    const code = iso2?.toUpperCase() || countryCode(partner);

    const candidates = code ? (this.byCode.get(code) ?? []) : [];

    return candidates.find((id) => onSheet.has(id)) ?? candidates[0] ?? null;
  }
}

type EngineResult = {
  feed_id?: unknown;
  month?: unknown;
  status?: unknown;
  partners?: unknown;
  unit?: unknown;
  source_url?: unknown;
  error?: unknown;
};

/**
 * One trade pass from the engine. A month read is staged (replacing a
 * pending one for the same month); a feed set to publish on its own does
 * so when every partner matched. Answers what became of each result.
 */
export async function recordFeedResults(siteId: number, results: EngineResult[], database: Database = db()) {
  const feeds = new Map(
    (await database.select().from(tradeFeeds).where(eq(tradeFeeds.siteId, siteId))).map((feed) => [feed.id, feed]),
  );
  const resolver = await PartnerResolver.forSite(siteId, database);
  const outcomes: Record<string, unknown>[] = [];

  for (const result of results) {
    const feed = feeds.get(Number(result.feed_id));
    const month = String(result.month ?? "");

    if (!feed || !/^\d{4}-\d{2}$/.test(month)) {
      outcomes.push({ feed_id: result.feed_id ?? null, status: "ignored" });
      continue;
    }

    const status = String(result.status ?? "");
    const error = result.error ? String(result.error).slice(0, 2000) : null;

    await database
      .update(tradeFeeds)
      .set({ lastCheckedAt: new Date(), lastStatus: status.slice(0, 24), lastError: status === "read" ? null : error })
      .where(eq(tradeFeeds.id, feed.id));

    if (status !== "read" || !Array.isArray(result.partners)) {
      outcomes.push({ feed_id: feed.id, month, status: status || "ignored" });
      continue;
    }

    const onSheet = await sheetPlaces(siteId, feed.kind, feed.locationId, database);
    const rows: TradeUpdateRow[] = [];

    for (const entry of result.partners as { partner?: unknown; iso2?: unknown; qty?: unknown }[]) {
      const partner = String(entry?.partner ?? "").trim().slice(0, 191);
      const qty = Number(entry?.qty);

      if (!partner || !Number.isFinite(qty) || qty <= 0) {
        continue;
      }

      const iso2 = typeof entry.iso2 === "string" && /^[A-Za-z]{2}$/.test(entry.iso2) ? entry.iso2.toUpperCase() : null;
      const locationId = resolver.resolve(partner, iso2, onSheet);

      rows.push({ partner, iso2, qty: qty.toFixed(3), locationId: locationId === feed.locationId ? null : locationId });
    }

    const update = await database.transaction(async (tx) => {
      await tx
        .delete(tradeUpdates)
        .where(and(eq(tradeUpdates.feedId, feed.id), eq(tradeUpdates.qtyDate, firstOf(month)), eq(tradeUpdates.status, "pending")));

      const [row] = await tx
        .insert(tradeUpdates)
        .values({
          siteId,
          feedId: feed.id,
          qtyDate: firstOf(month),
          rows,
          sourceUrl: typeof result.source_url === "string" ? result.source_url.slice(0, 2000) : null,
          sourceUnit: typeof result.unit === "string" ? result.unit.slice(0, 16) : null,
        })
        .returning({ id: tradeUpdates.id });

      return row!;
    });

    const unmatched = rows.filter((row) => row.locationId === null).length;

    if (feed.autoPublish && unmatched === 0 && rows.length > 0) {
      await publish(siteId, update.id, null, {}, database);
      outcomes.push({ feed_id: feed.id, month, status: "published", update_id: update.id });
    } else {
      outcomes.push({ feed_id: feed.id, month, status: "staged", update_id: update.id, unmatched });
    }
  }

  return outcomes;
}

/** Every partner place this sheet has ever held a figure for. */
async function sheetPlaces(siteId: number, kind: FeedKind, reporter: number, database: Database): Promise<Set<number>> {
  const rows = await database.execute<{ place: number }>(sql`
    select distinct case when kind = 'export' then to_location_id else from_location_id end as place
      from trade_quantities
     where site_id = ${siteId} and kind = ${kind}
       and (case when kind = 'export' then from_location_id else to_location_id end) = ${reporter}`);

  return new Set(rows.map((row) => row.place));
}

/* ---------------------------------------------------------- updates */

async function updateOf(siteId: number, id: number, database: Database) {
  const [found] = await database
    .select({ update: tradeUpdates, feed: tradeFeeds, reporter: tradeLocations.title })
    .from(tradeUpdates)
    .innerJoin(tradeFeeds, eq(tradeFeeds.id, tradeUpdates.feedId))
    .innerJoin(tradeLocations, eq(tradeLocations.id, tradeFeeds.locationId))
    .where(and(eq(tradeUpdates.id, id), eq(tradeUpdates.siteId, siteId)))
    .limit(1);

  if (!found) {
    throw new AccountError("That trade update could not be found.", 404, "id");
  }

  return found;
}

/** What the sheet holds for a month, by partner place. */
async function sheetFigures(siteId: number, kind: FeedKind, reporter: number, month: string, database: Database) {
  const reportingEnd = kind === "export" ? tradeQuantities.fromLocationId : tradeQuantities.toLocationId;
  const partnerEnd = kind === "export" ? tradeQuantities.toLocationId : tradeQuantities.fromLocationId;
  const rows = await database
    .select({ partner: partnerEnd, qty: tradeQuantities.qty })
    .from(tradeQuantities)
    .where(
      and(
        eq(tradeQuantities.siteId, siteId),
        eq(tradeQuantities.kind, kind),
        eq(reportingEnd, reporter),
        eq(tradeQuantities.qtyDate, firstOf(month)),
      ),
    );

  return new Map(rows.filter((row) => row.partner !== null && row.qty !== null).map((row) => [row.partner!, Number(row.qty)]));
}

export async function tradeUpdate(guard: Guarded, slug: string, id: number, database: Database = db()) {
  const brand = await brandOf(guard, slug, database);
  const { update, feed, reporter } = await updateOf(brand.id, id, database);
  const month = monthOf(update.qtyDate);
  const [current, previous, places] = await Promise.all([
    sheetFigures(brand.id, feed.kind, feed.locationId, month, database),
    sheetFigures(brand.id, feed.kind, feed.locationId, addMonths(month, -1), database),
    database
      .select({ id: tradeLocations.id, title: tradeLocations.title })
      .from(tradeLocations)
      .where(and(eq(tradeLocations.siteId, brand.id), isNull(tradeLocations.deletedAt)))
      .orderBy(tradeLocations.title),
  ]);
  const titles = new Map(places.map((place) => [place.id, place.title]));

  return {
    brand,
    id: update.id,
    status: update.status,
    month,
    month_name: monthName(month),
    reporter,
    kind: feed.kind,
    product: feed.product,
    source: SOURCE_LABELS[feed.source] ?? feed.source,
    source_url: update.sourceUrl,
    source_unit: update.sourceUnit,
    codes: feed.hsCodes,
    fetched_at: update.fetchedAt,
    decided_at: update.decidedAt,
    insight: {
      status: update.insightStatus,
      text: update.insightText,
      model: update.insightModel,
      error: update.insightError,
      at: update.insightAt,
    },
    rows: update.rows.map((row, index) => ({
      index,
      partner: row.partner,
      iso2: row.iso2,
      qty: Number(row.qty),
      location_id: row.locationId,
      place: row.locationId ? (titles.get(row.locationId) ?? null) : null,
      skipped: row.skipped ?? false,
      on_sheet: row.locationId ? (current.get(row.locationId) ?? null) : null,
      last_month: row.locationId ? (previous.get(row.locationId) ?? null) : null,
      suggested: row.iso2 ? countryName(row.iso2) : null,
    })),
    // On the sheet already, but not in what the source says now: removed
    // when this is published, because the source's month is the whole month.
    dropped: [...current.entries()]
      .filter(([place]) => !update.rows.some((row) => row.locationId === place))
      .map(([place, qty]) => ({ place: titles.get(place) ?? `#${place}`, qty })),
    places: places.filter((place) => place.id !== feed.locationId),
  };
}

/**
 * Write a staged month into the sheet. Every partner must be matched to a
 * place, marked to add as a new place, or left out; a match made by hand is
 * remembered for the next month. The month is replaced whole: figures the
 * source no longer lists for it are removed.
 */
async function publish(
  siteId: number,
  id: number,
  userId: number | null,
  choices: Record<string, string>,
  database: Database,
  context: Context = {},
): Promise<{ written: number; removed: number }> {
  const { update, feed } = await updateOf(siteId, id, database);

  if (update.status !== "pending") {
    throw new AccountError("That update has already been decided.", 409, "id");
  }

  const kind = feed.kind;
  const date = update.qtyDate;

  return database.transaction(async (tx) => {
    const rows: TradeUpdateRow[] = [];

    for (const [index, row] of update.rows.entries()) {
      const choice = choices[String(index)];

      if (choice === "skip") {
        rows.push({ ...row, locationId: null, skipped: true });
        continue;
      }

      if (choice === "new") {
        const title = (row.iso2 && countryName(row.iso2)) || row.partner;
        const [existing] = await tx
          .select({ id: tradeLocations.id })
          .from(tradeLocations)
          .where(and(eq(tradeLocations.siteId, siteId), sql`lower(${tradeLocations.title}) = ${title.toLowerCase()}`))
          .limit(1);
        const placeId =
          existing?.id ??
          (await tx.insert(tradeLocations).values({ siteId, title }).returning({ id: tradeLocations.id }))[0]!.id;

        rows.push({ ...row, locationId: placeId, skipped: false });
        continue;
      }

      if (choice && /^\d+$/.test(choice)) {
        const [place] = await tx
          .select({ id: tradeLocations.id })
          .from(tradeLocations)
          .where(and(eq(tradeLocations.id, Number(choice)), eq(tradeLocations.siteId, siteId), isNull(tradeLocations.deletedAt)))
          .limit(1);

        if (!place || place.id === feed.locationId) {
          throw new AccountError(`Choose one of this brand's countries for ${row.partner}.`, 422, "matches");
        }

        if (place.id !== row.locationId) {
          await tx
            .delete(tradeLocationAliases)
            .where(and(eq(tradeLocationAliases.siteId, siteId), sql`lower(${tradeLocationAliases.alias}) = ${row.partner.toLowerCase()}`));
          await tx.insert(tradeLocationAliases).values({ siteId, alias: row.partner, locationId: place.id });
        }

        rows.push({ ...row, locationId: place.id, skipped: false });
        continue;
      }

      if (row.locationId === null && !row.skipped) {
        throw new AccountError(`Match ${row.partner} to one of the brand's countries, add it, or leave it out.`, 422, "matches");
      }

      rows.push(row);
    }

    // Two source names can land on one place: their figures add up.
    const totals = new Map<number, number>();

    for (const row of rows) {
      if (row.locationId !== null && !row.skipped) {
        totals.set(row.locationId, (totals.get(row.locationId) ?? 0) + Number(row.qty));
      }
    }

    const reportingEnd = kind === "export" ? tradeQuantities.fromLocationId : tradeQuantities.toLocationId;
    const partnerEnd = kind === "export" ? tradeQuantities.toLocationId : tradeQuantities.fromLocationId;
    const keep = [...totals.keys()];
    const removed = await tx
      .delete(tradeQuantities)
      .where(
        and(
          eq(tradeQuantities.siteId, siteId),
          eq(tradeQuantities.kind, kind),
          eq(reportingEnd, feed.locationId),
          eq(tradeQuantities.qtyDate, date),
          keep.length ? sql`${partnerEnd} not in (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})` : undefined,
        ),
      )
      .returning({ id: tradeQuantities.id });

    for (const [place, qty] of totals) {
      const ends =
        kind === "export" ? { fromLocationId: feed.locationId, toLocationId: place } : { fromLocationId: place, toLocationId: feed.locationId };

      await tx
        .insert(tradeQuantities)
        .values({ siteId, kind, qtyDate: date, qty: qty.toFixed(3), ...ends })
        .onConflictDoUpdate({
          target: [
            tradeQuantities.siteId,
            tradeQuantities.kind,
            tradeQuantities.fromLocationId,
            tradeQuantities.toLocationId,
            tradeQuantities.qtyDate,
          ],
          set: { qty: qty.toFixed(3) },
        });
    }

    await tx
      .update(tradeUpdates)
      .set({ status: "published", rows, decidedAt: new Date(), decidedBy: userId })
      .where(eq(tradeUpdates.id, update.id));

    await tx.insert(auditLog).values({
      siteId,
      userId,
      action: "trade.update.publish",
      entity: "trade_update",
      entityId: update.id,
      detail: { feed: feed.id, month: monthOf(date), written: totals.size, removed: removed.length, automatic: userId === null },
      ip: context.ip ?? null,
    });

    return { written: totals.size, removed: removed.length };
  });
}

export async function publishUpdate(
  guard: Guarded,
  input: { site: string; id: unknown; matches?: Record<string, string> },
  context: Context = {},
  database: Database = db(),
) {
  const brand = await brandOf(guard, input.site, database);

  const result = await publish(brand.id, Number(input.id), guard.identity.user.id, input.matches ?? {}, database, context);

  return { ...result, siteId: brand.id };
}

export async function discardUpdate(guard: Guarded, input: { site: string; id: unknown }, context: Context = {}, database: Database = db()) {
  const brand = await brandOf(guard, input.site, database);
  const [row] = await database
    .update(tradeUpdates)
    .set({ status: "discarded", decidedAt: new Date(), decidedBy: guard.identity.user.id })
    .where(and(eq(tradeUpdates.id, Number(input.id)), eq(tradeUpdates.siteId, brand.id), eq(tradeUpdates.status, "pending")))
    .returning({ id: tradeUpdates.id });

  if (!row) {
    throw new AccountError("That update is not waiting to be decided.", 409, "id");
  }

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "trade.update.discard",
    entity: "trade_update",
    entityId: row.id,
    detail: {},
    ip: context.ip ?? null,
  });
}

/* ---------------------------------------------------------- insight */

const pct = (now: number, then: number) => (then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : null);

/**
 * The figures the model narrates, all worked out here: the month's total
 * against the month before and the same month a year earlier, the leading
 * partners with their shares and moves, and who appeared or dropped away.
 */
export async function insightFigures(siteId: number, feed: { kind: FeedKind; locationId: number; product: string }, month: string, unit: string | null, database: Database = db()) {
  const [now, before, lastYear] = await Promise.all([
    sheetFigures(siteId, feed.kind, feed.locationId, month, database),
    sheetFigures(siteId, feed.kind, feed.locationId, addMonths(month, -1), database),
    sheetFigures(siteId, feed.kind, feed.locationId, addMonths(month, -12), database),
  ]);
  const ids = [...new Set([...now.keys(), ...before.keys()])];
  const titles = new Map(
    ids.length
      ? (
          await database
            .select({ id: tradeLocations.id, title: tradeLocations.title })
            .from(tradeLocations)
            .where(inArray(tradeLocations.id, ids))
        ).map((place) => [place.id, place.title])
      : [],
  );
  const sum = (figures: Map<number, number>) => [...figures.values()].reduce((a, b) => a + b, 0);
  const total = sum(now);
  const priorTotal = sum(before);
  const yearTotal = sum(lastYear);
  const leading = [...now.entries()].sort((a, b) => b[1] - a[1]);

  return {
    product: feed.product,
    direction: feed.kind === "import" ? "imports" : "exports",
    month: monthName(month),
    unit: unit === "LTR" ? "thousand litres (kilolitres)" : "tonnes",
    total,
    partner_count: now.size,
    previous_month: { month: monthName(addMonths(month, -1)), total: priorTotal || null, change_percent: pct(total, priorTotal) },
    same_month_last_year: { month: monthName(addMonths(month, -12)), total: yearTotal || null, change_percent: pct(total, yearTotal) },
    leading_partners: leading.slice(0, 10).map(([place, qty]) => ({
      partner: titles.get(place) ?? `#${place}`,
      quantity: qty,
      share_percent: total > 0 ? Math.round((qty / total) * 1000) / 10 : null,
      previous_month: before.get(place) ?? null,
      change_percent: pct(qty, before.get(place) ?? 0),
    })),
    other_partners_total: leading.slice(10).reduce((a, [, qty]) => a + qty, 0),
    new_this_month: leading.filter(([place]) => !before.has(place)).slice(0, 5).map(([place, qty]) => ({ partner: titles.get(place) ?? `#${place}`, quantity: qty })),
    absent_this_month: [...before.entries()]
      .filter(([place]) => !now.has(place))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([place, qty]) => ({ partner: titles.get(place) ?? `#${place}`, previous_month: qty })),
  };
}

/** Ask the brand's model for the market insight on a published month. */
export async function writeInsight(siteId: number, id: number, actor: string, database: Database = db()) {
  const { update, feed, reporter } = await updateOf(siteId, id, database);
  const [brand] = await database.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  const month = monthOf(update.qtyDate);
  const figures = await insightFigures(siteId, feed, month, update.sourceUnit, database);
  const title = `${reporter} ${feed.product} ${feed.kind === "import" ? "imports" : "exports"} — ${monthName(month)}`;
  let outcome: { status: string; output_markdown: string | null; model: string | null; error: string | null };

  try {
    outcome = (
      await engine<{ analysis: typeof outcome }>(brand!.slug, "trade-insight", {
        method: "POST",
        actor,
        timeout: INSIGHT_TIMEOUT,
        json: { title, figures },
      })
    ).analysis;
  } catch (error) {
    if (!(error instanceof EngineError)) {
      throw error;
    }

    outcome = { status: "failed", output_markdown: null, model: null, error: error.message };
  }

  await database
    .update(tradeUpdates)
    .set({
      insightStatus: outcome.status.slice(0, 24),
      insightText: outcome.output_markdown?.trim() || null,
      insightModel: outcome.model?.slice(0, 120) ?? null,
      insightError: outcome.error,
      insightAt: new Date(),
    })
    .where(eq(tradeUpdates.id, update.id));

  return { status: outcome.status, error: outcome.error };
}

/** The insight again, on request, for a published month. */
export async function requestInsight(guard: Guarded, input: { site: string; id: unknown }, database: Database = db()) {
  const brand = await brandOf(guard, input.site, database);
  const { update } = await updateOf(brand.id, Number(input.id), database);

  if (update.status !== "published") {
    throw new AccountError("Publish the month first; the insight is written from the published figures.", 409, "id");
  }

  return writeInsight(brand.id, update.id, guard.identity.user.email, database);
}

/** Ask the engine to check this brand's feeds now. */
export async function checkFeedsNow(guard: Guarded, slug: string, database: Database = db()) {
  const brand = await brandOf(guard, slug, database);

  try {
    return await engine<{ results: { feed_id: number; month: string; status: string; error?: string }[] }>(brand.slug, "trade/check", {
      method: "POST",
      actor: guard.identity.user.email,
      timeout: 300_000,
      json: {},
    });
  } catch (error) {
    if (error instanceof EngineError) {
      throw new AccountError(`The engine could not check the feeds: ${error.message}`, 422, "engine");
    }

    throw error;
  }
}
