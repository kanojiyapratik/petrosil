/**
 * A member posting, changing and withdrawing their own offers on a brand site.
 *
 * The old site's update and delete took an offer's number from any signed-in
 * user and changed it, whoever had posted it. Here a member reaches only
 * offers they posted, and never the status: a member's post goes live at
 * once, as before, and staff can suspend it, which the member cannot undo.
 *
 * The same field rules as the staff editor (`./editor.ts`), so an offer reads
 * the same whoever typed it. Ten posts a day per member keeps a bot from
 * filling the board.
 */

import { and, count, desc, eq, gte, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, offers } from "@/db/schema";
import { AccountError } from "@/domain/accounts/register";
import { contactEmail, offerType, subject, textChanges } from "./editor";

const DAILY_POSTS = 10;

export type MyOffer = {
  id: number;
  subject: string;
  offer_type: string;
  status: string;
  offer_value: string | null;
  clicks: number;
  posted_on: string;
};

const mine = (row: typeof offers.$inferSelect): MyOffer => ({
  id: row.id,
  subject: row.subject,
  offer_type: row.offerType,
  status: row.status,
  offer_value: row.offerValue,
  clicks: row.clicks,
  posted_on: row.createdAt.toISOString().slice(0, 10),
});

export async function postOffer(
  userId: number,
  siteId: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<MyOffer> {
  const [today] = await database
    .select({ n: count() })
    .from(offers)
    .where(and(eq(offers.userId, userId), eq(offers.siteId, siteId), gte(offers.createdAt, new Date(Date.now() - 86_400_000))));

  if ((today?.n ?? 0) >= DAILY_POSTS) {
    throw new AccountError(`That is ${DAILY_POSTS} offers today. Post more tomorrow.`, 429);
  }

  const [row] = await database
    .insert(offers)
    .values({
      siteId,
      userId,
      subject: subject(body.subject),
      offerType: offerType(body.offer_type),
      contactEmail: contactEmail(body.contact_email),
      status: "published",
      ...textChanges(body),
    })
    .returning();

  await database.insert(auditLog).values({
    siteId,
    userId,
    action: "offer.post",
    entity: "offer",
    entityId: row!.id,
    detail: { subject: row!.subject },
    ip: context.ip ?? null,
  });

  return mine(row!);
}

async function own(userId: number, siteId: number, id: number, database: Database) {
  const [row] = await database
    .select()
    .from(offers)
    .where(and(eq(offers.id, id), eq(offers.siteId, siteId), eq(offers.userId, userId), isNull(offers.deletedAt)))
    .limit(1);

  return row ?? null;
}

/** Null when the offer is not this member's. */
export async function updateMyOffer(
  userId: number,
  siteId: number,
  id: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<MyOffer | null> {
  const found = await own(userId, siteId, id, database);

  if (!found) {
    return null;
  }

  // An allow-list: status, poster and attachments are not a member's to set.
  const changes: Partial<typeof offers.$inferInsert> = textChanges(body);

  if (body.subject !== undefined) changes.subject = subject(body.subject);
  if (body.offer_type !== undefined) changes.offerType = offerType(body.offer_type);
  if (body.contact_email !== undefined) changes.contactEmail = contactEmail(body.contact_email);

  const [after] = await database
    .update(offers)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(offers.id, id))
    .returning();

  await database.insert(auditLog).values({
    siteId,
    userId,
    action: "offer.member-update",
    entity: "offer",
    entityId: id,
    detail: { fields: Object.keys(changes) },
    ip: context.ip ?? null,
  });

  return mine(after!);
}

/** Withdraw, as staff do: enquiries about it keep their link. False when it is not this member's. */
export async function withdrawMyOffer(
  userId: number,
  siteId: number,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const found = await own(userId, siteId, id, database);

  if (!found) {
    return false;
  }

  await database.update(offers).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(offers.id, id));

  await database.insert(auditLog).values({
    siteId,
    userId,
    action: "offer.member-withdraw",
    entity: "offer",
    entityId: id,
    detail: { subject: found.subject },
    ip: context.ip ?? null,
  });

  return true;
}

/** A member's own offers on a brand, newest first, suspended ones included so they can see why one is gone. */
export async function myOffers(userId: number, siteId: number, database: Database = db()): Promise<MyOffer[]> {
  const rows = await database
    .select()
    .from(offers)
    .where(and(eq(offers.userId, userId), eq(offers.siteId, siteId), isNull(offers.deletedAt)))
    .orderBy(desc(offers.createdAt), desc(offers.id));

  return rows.map(mine);
}
