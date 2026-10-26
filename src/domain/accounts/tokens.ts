/**
 * One-shot links: issue one, spend one.
 *
 * Spending is a single UPDATE with `used_at is null` in its WHERE clause, not
 * a read followed by a write. Two clicks on the same reset link arriving
 * together would both pass a read-then-write check, and the second would set
 * a password the first user never chose.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { authTokens } from "@/db/schema";

export type Purpose = "verify_email" | "reset_password" | "staff_invite";

/** How long each kind of link lives. A reset is short because it is a key. */
export const LIFETIME_MINUTES: Record<Purpose, number> = {
  verify_email: 7 * 24 * 60,
  reset_password: 60,
  // An invitation waits for someone to read their mail; a week, as for a confirmation.
  staff_invite: 7 * 24 * 60,
};

const digest = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export async function issueToken(
  input: { userId: number; purpose: Purpose; siteId?: number | null },
  database: Database = db(),
): Promise<string> {
  const token = randomBytes(32).toString("base64url");

  await database.insert(authTokens).values({
    userId: input.userId,
    siteId: input.siteId ?? null,
    purpose: input.purpose,
    tokenHash: digest(token),
    expiresAt: new Date(Date.now() + LIFETIME_MINUTES[input.purpose] * 60 * 1000),
  });

  return token;
}

/** The row behind a link, without spending it. Null when it cannot be used. */
export async function peekToken(
  token: unknown,
  purpose: Purpose,
  database: Database = db(),
): Promise<typeof authTokens.$inferSelect | null> {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const [row] = await database
    .select()
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, digest(token)),
        // Purpose is part of the lookup, not a check afterwards: a
        // confirmation link must not be spendable as a password reset.
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
      ),
    )
    .limit(1);

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return row;
}

/**
 * Spend it. Returns the row when this call was the one that spent it, null
 * when it was already gone — so a double click cannot act twice.
 */
export async function spendToken(
  token: unknown,
  purpose: Purpose,
  database: Database = db(),
): Promise<typeof authTokens.$inferSelect | null> {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  const [row] = await database
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, digest(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt),
        sql`${authTokens.expiresAt} > now()`,
      ),
    )
    .returning();

  return row ?? null;
}
