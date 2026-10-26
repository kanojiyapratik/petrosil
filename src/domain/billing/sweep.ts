/**
 * The sweep that ends a term.
 *
 * The old estate ran this by visiting `admin/artisan/subscription` in a
 * browser — a URL anyone could hit and nobody remembered to. It is a function
 * here, called by `scripts/sweep-expiries.ts`, so it can be put on a schedule
 * and so it can be tested.
 *
 * Note what it does NOT do: it does not clear `expires_at`. The date a term
 * ran out is what lets a screen tell a lapsed subscriber from someone who
 * never paid, and telling those two apart is most of renewals.
 */

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, memberships } from "@/db/schema";
import { today } from "@/domain/price/dates";

/** Y-m-d, days added in the calendar. Used for trial terms. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

export async function sweepExpiries(
  database: Database = db(),
  now: string = today(),
): Promise<{ lapsed: number }> {
  const due = await database
    .select()
    .from(memberships)
    .where(
      and(
        // Readers only. A staff grant is not a subscription and has no term;
        // sweeping one would lock an editor out of their own brand.
        eq(memberships.role, "subscriber"),
        inArray(memberships.tier, ["premium", "trial"]),
        // An open-ended subscription has no expiry and never lapses.
        isNotNull(memberships.expiresAt),
        // Strictly before today: a term ending today is still live today,
        // which is the same boundary the paywall uses.
        lt(memberships.expiresAt, now),
      ),
    );

  if (due.length === 0) {
    return { lapsed: 0 };
  }

  await database
    .update(memberships)
    // `lapsed_from` keeps what they had, so the reminder that follows is the
    // trial one or the subscription one, not a guess.
    .set({ tier: "free", lapsedFrom: sql`${memberships.tier}`, updatedAt: new Date() })
    .where(
      inArray(
        memberships.id,
        due.map((row) => row.id),
      ),
    );

  await database.insert(auditLog).values(
    due.map((row) => ({
      siteId: row.siteId,
      userId: row.userId,
      action: "membership.lapsed",
      entity: "membership",
      entityId: row.id,
      detail: { was: row.tier, expired: row.expiresAt },
    })),
  );

  return { lapsed: due.length };
}
