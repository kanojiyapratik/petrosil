/**
 * The currencies prices and plans are quoted in.
 *
 * One list for the whole estate, so only a superadmin changes it: a brand's
 * staff switching off a currency would take it away from the other eight. A
 * currency a location is priced in cannot be switched off, since every price
 * for that location would then be in a currency the screens cannot name.
 */

import { and, count, eq, isNull, ne } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, currencies, locations } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";

export type CurrencyInput = { id?: number; code: unknown; title: unknown; symbol: unknown; enabled: boolean };

export async function saveCurrency(
  guard: Guarded,
  input: CurrencyInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number; code: string }> {
  if (!guard.isSuperadmin) {
    throw new AccountError("Currencies are shared by every brand, so only a superadmin can change them.", 403);
  }

  const [existing] = input.id !== undefined
    ? await database.select().from(currencies).where(eq(currencies.id, input.id)).limit(1)
    : [];

  if (input.id !== undefined && !existing) {
    throw new AccountError("We cannot find that currency.", 404);
  }

  const code = String(input.code ?? "").trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(code)) {
    throw new AccountError("A currency code is three letters, like INR.", 422, "code");
  }

  const title = String(input.title ?? "").trim().slice(0, 96);
  const symbol = String(input.symbol ?? "").trim().slice(0, 8);

  if (title === "") {
    throw new AccountError("Give the currency its name.", 422, "title");
  }

  if (symbol === "") {
    throw new AccountError("Give the currency its symbol.", 422, "symbol");
  }

  const [clash] = await database
    .select({ id: currencies.id })
    .from(currencies)
    .where(and(eq(currencies.code, code), existing ? ne(currencies.id, existing.id) : undefined))
    .limit(1);

  if (clash) {
    throw new AccountError(`${code} is already on the list.`, 409, "code");
  }

  if (existing && !input.enabled) {
    const [priced] = await database
      .select({ n: count() })
      .from(locations)
      .where(and(eq(locations.currency, existing.code), isNull(locations.deletedAt)));

    if ((priced?.n ?? 0) > 0) {
      throw new AccountError(
        `${priced!.n} location${priced!.n === 1 ? " is" : "s are"} priced in ${existing.code}, so it stays switched on.`,
        409,
        "enabled",
      );
    }
  }

  const values = { code, title, symbol, enabled: input.enabled };
  const [row] = existing
    ? await database.update(currencies).set(values).where(eq(currencies.id, existing.id)).returning()
    : await database.insert(currencies).values(values).returning();

  await database.insert(auditLog).values({
    siteId: null,
    userId: guard.identity.user.id,
    action: existing ? "currency.update" : "currency.create",
    entity: "currency",
    entityId: row!.id,
    detail: existing ? { was: { code: existing.code, title: existing.title, enabled: existing.enabled }, now: values } : values,
    ip: context.ip ?? null,
  });

  return { id: row!.id, code: row!.code };
}
