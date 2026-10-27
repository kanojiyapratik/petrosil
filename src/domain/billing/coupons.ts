/**
 * Creating and changing discount codes.
 *
 * A code is switched off, never deleted: paid orders point at it. A code with
 * no brand works on all nine, so only a superadmin may make or change one —
 * brand staff could otherwise discount another brand's plans. The cap cannot
 * be set below the times the code has already been used, which would leave
 * a code that reads "used 7 of 3".
 */

import { and, eq, ne } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, coupons, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { countInput, currencyInput, dateInput, moneyInput } from "./inputs";

export type CouponInput = {
  id?: number;
  /** The brand's slug, or "" for every brand. New codes only: a code does not move between brands. */
  site?: string;
  code: unknown;
  kind: unknown;
  value: unknown;
  currency?: unknown;
  max_redemptions?: unknown;
  starts_at?: unknown;
  expires_at?: unknown;
  enabled: boolean;
};

export type SavedCoupon = { id: number; code: string };

/** Null when the code is not one this editor may change. */
export async function saveCoupon(
  guard: Guarded,
  input: CouponInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<SavedCoupon | null> {
  let existing: typeof coupons.$inferSelect | undefined;
  let siteId: number | null;

  if (input.id !== undefined) {
    [existing] = await database.select().from(coupons).where(eq(coupons.id, input.id)).limit(1);

    const mine =
      existing &&
      (guard.isSuperadmin || (existing.siteId !== null && guard.siteIds.includes(existing.siteId)));

    if (!existing || !mine) {
      return null;
    }

    siteId = existing.siteId;
  } else if (String(input.site ?? "") === "") {
    if (!guard.isSuperadmin) {
      throw new AccountError("Only a superadmin can make a code that works on every brand.", 403, "site");
    }

    siteId = null;
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site))).limit(1);

    if (!brand) {
      throw new AccountError("Choose a brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
  }

  if (siteId !== null) {
    await requirePermission(guard, siteId, existing ? "coupon-edit" : "coupon-create", database);
  }

  const code = String(input.code ?? "").trim().toUpperCase();

  if (!/^[A-Z0-9_-]{3,64}$/.test(code)) {
    throw new AccountError("A code is 3 to 64 letters, digits, - or _.", 422, "code");
  }

  const [clash] = await database
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.code, code), existing ? ne(coupons.id, existing.id) : undefined))
    .limit(1);

  if (clash) {
    // Codes are unique across the estate: a customer types one into any brand's checkout.
    throw new AccountError("That code is already in use on one of the brands.", 409, "code");
  }

  let percentOff: number | null = null;
  let amountOff: string | null = null;
  let currency: string | null = null;

  if (input.kind === "percent") {
    percentOff = countInput(input.value, "value", 1, 100, "A percentage is a whole number from 1 to 100.");

    if (percentOff === null) {
      throw new AccountError("A percentage is a whole number from 1 to 100.", 422, "value");
    }
  } else if (input.kind === "amount") {
    amountOff = moneyInput(input.value, "value");

    if (Number(amountOff) <= 0) {
      throw new AccountError("A discount has to take something off.", 422, "value");
    }

    if (String(input.currency ?? "").trim() === "") {
      throw new AccountError("A fixed amount needs its currency: it only applies to plans priced in it.", 422, "currency");
    }

    currency = currencyInput(input.currency);
  } else {
    throw new AccountError("Choose a percentage or a fixed amount.", 422, "kind");
  }

  const maxRedemptions = countInput(input.max_redemptions, "max_redemptions", 1, 1_000_000, "A cap is a whole number, or blank for no cap.");

  if (existing && maxRedemptions !== null && maxRedemptions < existing.redeemed) {
    throw new AccountError(
      `It has already been used ${existing.redeemed} times, so the cap cannot be lower than that.`,
      422,
      "max_redemptions",
    );
  }

  const startsAt = dateInput(input.starts_at, "starts_at");
  const expiresAt = dateInput(input.expires_at, "expires_at");

  if (startsAt && expiresAt && expiresAt < startsAt) {
    throw new AccountError("It would expire before it starts.", 422, "expires_at");
  }

  const values = {
    code,
    percentOff,
    amountOff,
    currency,
    maxRedemptions,
    startsAt,
    expiresAt,
    enabled: input.enabled,
  };

  const [row] = existing
    ? await database.update(coupons).set(values).where(eq(coupons.id, existing.id)).returning()
    : await database.insert(coupons).values({ ...values, siteId }).returning();

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "coupon.update" : "coupon.create",
    entity: "coupon",
    entityId: row!.id,
    detail: {
      ...(existing
        ? {
            was: {
              code: existing.code,
              percent_off: existing.percentOff,
              amount_off: existing.amountOff,
              max_redemptions: existing.maxRedemptions,
              expires_at: existing.expiresAt,
              enabled: existing.enabled,
            },
          }
        : {}),
      now: { code, percent_off: percentOff, amount_off: amountOff, max_redemptions: maxRedemptions, expires_at: expiresAt, enabled: input.enabled },
    },
    ip: context.ip ?? null,
  });

  return { id: row!.id, code: row!.code };
}

/** One code for its editor. Estate-wide codes are shown to everyone but editable by superadmins only. */
export async function couponForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select({ coupon: coupons, slug: sites.slug })
    .from(coupons)
    .leftJoin(sites, eq(sites.id, coupons.siteId))
    .where(eq(coupons.id, id))
    .limit(1);

  if (!row) {
    return null;
  }

  const { coupon } = row;

  if (siteIds.length > 0 && (coupon.siteId === null || !siteIds.includes(coupon.siteId))) {
    return null;
  }

  return {
    id: coupon.id,
    site: row.slug,
    code: coupon.code,
    kind: coupon.percentOff !== null ? ("percent" as const) : ("amount" as const),
    value: coupon.percentOff !== null ? String(coupon.percentOff) : (coupon.amountOff ?? ""),
    currency: coupon.currency,
    max_redemptions: coupon.maxRedemptions,
    redeemed: coupon.redeemed,
    starts_at: coupon.startsAt,
    expires_at: coupon.expiresAt,
    enabled: coupon.enabled,
  };
}

export type CouponForEdit = NonNullable<Awaited<ReturnType<typeof couponForEdit>>>;
