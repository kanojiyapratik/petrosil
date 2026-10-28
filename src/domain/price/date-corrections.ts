/**
 * Correcting a whole date: the old admin's date list, its by-date edit and
 * its bulk delete.
 *
 * The old screens rewrote any price on any date in place and deleted every
 * price on a date from one click, with no permission check and no record.
 * Here the owner's rule stands — a published price on a past date is history
 * and is never overwritten — so a wrong figure is corrected in the open
 * instead: withdraw it (one market, several, or the whole date), then enter
 * the right one on the price grid, which accepts an empty past date. Every
 * withdrawal is kept in the audit trail with the figures it took down, and
 * can be put back.
 */

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, locations, priceBatchItems, priceBatches, prices, sites, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";

import { parseDate } from "./dates";

export const PER_PAGE = 50;

export type DateRow = { date: string; prices: number };

export type DatePrice = {
  id: number;
  locationId: number;
  title: string;
  visible: boolean;
  price: string;
  currency: string | null;
  /** The committed update that last wrote this figure; null for figures carried from the old site. */
  setBy: { batchId: number; source: string } | null;
};

export type Withdrawal = {
  id: number;
  at: Date;
  by: string | null;
  prices: { id: number; locationId: number; title: string; price: string }[];
  /** When it was put back, if it was. */
  putBackAt: Date | null;
};

type WithdrawalDetail = { date: string; prices: Withdrawal["prices"] };

async function brandFor(guard: Guarded, slug: string, permission: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, permission, database);

  return brand;
}

function dateOf(value: unknown): string {
  const date = parseDate(value);

  if (!date) {
    throw new AccountError("Choose a price date.", 422, "date");
  }

  return date;
}

/** Every date the brand has prices on, newest first, with how many. */
export async function priceDates(
  guard: Guarded,
  input: { site: string; page?: number },
  database: Database = db(),
): Promise<{ markets: number; total: number; rows: DateRow[] }> {
  const brand = await brandFor(guard, input.site, "price-batch-view", database);
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const live = and(eq(prices.siteId, brand.id), isNull(prices.deletedAt));

  const [rows, [dates], [markets]] = await Promise.all([
    database
      .select({ date: prices.priceDate, prices: count() })
      .from(prices)
      .where(live)
      .groupBy(prices.priceDate)
      .orderBy(desc(prices.priceDate))
      .limit(PER_PAGE)
      .offset((page - 1) * PER_PAGE),
    database.select({ n: sql<number>`count(distinct ${prices.priceDate})::int` }).from(prices).where(live),
    database
      .select({ n: count() })
      .from(locations)
      .where(and(eq(locations.siteId, brand.id), isNull(locations.deletedAt))),
  ]);

  return { markets: markets?.n ?? 0, total: dates?.n ?? 0, rows };
}

/** One date: every price published on it, what wrote each, and what was withdrawn from it. */
export async function dateSheet(
  guard: Guarded,
  input: { site: string; date: unknown },
  database: Database = db(),
): Promise<{ date: string; markets: number; prices: DatePrice[]; withdrawals: Withdrawal[] }> {
  const brand = await brandFor(guard, input.site, "price-batch-view", database);
  const date = dateOf(input.date);

  const rows = await database
    .select({
      id: prices.id,
      locationId: prices.locationId,
      title: locations.title,
      visible: locations.visible,
      price: prices.price,
      currency: sql<string | null>`coalesce(${locations.currency}, ${prices.currency})`,
    })
    .from(prices)
    .innerJoin(locations, eq(locations.id, prices.locationId))
    .where(and(eq(prices.siteId, brand.id), eq(prices.priceDate, date), isNull(prices.deletedAt), isNull(locations.deletedAt)))
    .orderBy(locations.sortOrder, locations.title);

  const writers = rows.length
    ? await database
        .selectDistinctOn([priceBatchItems.priceId], {
          priceId: priceBatchItems.priceId,
          batchId: priceBatches.id,
          source: priceBatches.source,
        })
        .from(priceBatchItems)
        .innerJoin(priceBatches, eq(priceBatches.id, priceBatchItems.batchId))
        .where(
          and(
            inArray(
              priceBatchItems.priceId,
              rows.map((row) => row.id),
            ),
            eq(priceBatches.status, "committed"),
            inArray(priceBatchItems.status, ["new", "changed"]),
          ),
        )
        .orderBy(priceBatchItems.priceId, desc(priceBatches.id))
    : [];

  const byPrice = new Map(writers.map((row) => [row.priceId, { batchId: row.batchId, source: row.source }]));

  const [markets] = await database
    .select({ n: count() })
    .from(locations)
    .where(and(eq(locations.siteId, brand.id), isNull(locations.deletedAt)));

  return {
    date,
    markets: markets?.n ?? 0,
    prices: rows.map((row) => ({ ...row, setBy: byPrice.get(row.id) ?? null })),
    withdrawals: await withdrawalsOn(brand.id, date, database),
  };
}

async function withdrawalsOn(siteId: number, date: string, database: Database): Promise<Withdrawal[]> {
  const taken = await database
    .select({ id: auditLog.id, at: auditLog.createdAt, detail: auditLog.detail, by: users.name, email: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(and(eq(auditLog.siteId, siteId), eq(auditLog.action, "price.withdraw"), sql`${auditLog.detail}->>'date' = ${date}`))
    .orderBy(desc(auditLog.id));

  if (taken.length === 0) {
    return [];
  }

  const returned = await database
    .select({ withdrawal: auditLog.entityId, at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.siteId, siteId),
        eq(auditLog.action, "price.put_back"),
        inArray(
          auditLog.entityId,
          taken.map((row) => row.id),
        ),
      ),
    );

  const putBack = new Map(returned.map((row) => [row.withdrawal, row.at]));

  return taken.map((row) => ({
    id: row.id,
    at: row.at,
    by: row.by ?? row.email ?? null,
    prices: (row.detail as WithdrawalDetail).prices,
    putBackAt: putBack.get(row.id) ?? null,
  }));
}

/**
 * Take published prices on one date down. `priceIds` are the ticked rows;
 * ticking every row is the old "delete the date". Ids that are not this
 * brand's live prices on this date are refused, so a stale form cannot reach
 * another day.
 */
export async function withdrawPrices(
  guard: Guarded,
  input: { site: string; date: unknown; priceIds: number[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ withdrawn: number; withdrawalId: number }> {
  const brand = await brandFor(guard, input.site, "price-batch-rollback", database);
  const date = dateOf(input.date);
  const ids = [...new Set(input.priceIds.filter((id) => Number.isInteger(id) && id > 0))];

  if (ids.length === 0) {
    throw new AccountError("Tick the prices to withdraw.", 422, "prices");
  }

  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: prices.id, locationId: prices.locationId, title: locations.title, price: prices.price })
      .from(prices)
      .innerJoin(locations, eq(locations.id, prices.locationId))
      .where(and(inArray(prices.id, ids), eq(prices.siteId, brand.id), eq(prices.priceDate, date), isNull(prices.deletedAt)))
      .for("update", { of: prices });

    if (rows.length !== ids.length) {
      throw new AccountError("Some of those prices are no longer published on this date. Reload and try again.", 409, "prices");
    }

    await tx.update(prices).set({ deletedAt: new Date(), updatedAt: new Date() }).where(inArray(prices.id, ids));

    const [entry] = await tx
      .insert(auditLog)
      .values({
        siteId: brand.id,
        userId: guard.identity.user.id,
        action: "price.withdraw",
        entity: "price",
        detail: { date, prices: rows } satisfies WithdrawalDetail,
        ip: context.ip ?? null,
      })
      .returning({ id: auditLog.id });

    return { withdrawn: rows.length, withdrawalId: entry!.id };
  });
}

/**
 * Undo a withdrawal. A market that has had a price entered on that date
 * since keeps the newer figure — the later entry is the newer intent, the
 * same rule a batch rollback follows — and is counted as skipped.
 */
export async function putBack(
  guard: Guarded,
  input: { site: string; withdrawalId: number },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ restored: number; skipped: number }> {
  const brand = await brandFor(guard, input.site, "price-batch-rollback", database);

  return database.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.id, input.withdrawalId), eq(auditLog.siteId, brand.id), eq(auditLog.action, "price.withdraw")))
      .limit(1)
      .for("update");

    if (!entry) {
      throw new AccountError("No such withdrawal.", 404, "withdrawal");
    }

    const [already] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "price.put_back"), eq(auditLog.entityId, entry.id)))
      .limit(1);

    if (already) {
      throw new AccountError("That withdrawal has already been put back.", 409, "withdrawal");
    }

    const detail = entry.detail as WithdrawalDetail;
    const result = { restored: 0, skipped: 0 };

    for (const taken of detail.prices) {
      const [occupied] = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(and(eq(prices.locationId, taken.locationId), eq(prices.priceDate, detail.date), isNull(prices.deletedAt)))
        .limit(1);

      const restored = occupied
        ? []
        : await tx
            .update(prices)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(and(eq(prices.id, taken.id), eq(prices.siteId, brand.id)))
            .returning({ id: prices.id });

      if (restored.length) {
        result.restored += 1;
      } else {
        result.skipped += 1;
      }
    }

    await tx.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "price.put_back",
      entity: "audit_log",
      entityId: entry.id,
      detail: { date: detail.date, ...result },
      ip: context.ip ?? null,
    });

    return result;
  });
}
