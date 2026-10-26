/**
 * The enquiries inbox: what came in, and whether anyone has dealt with it.
 *
 * "Handled" is all the state there is, with an optional note — the reply
 * itself happens in a mailbox, as it always has. What is new is that the
 * question "did anyone answer the man from Jebel Ali?" has an answer.
 */

import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db, type Database } from "@/db";
import { auditLog, enquiries, sites, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { paging } from "@/domain/dashboard/scope";

const handler = alias(users, "handler");

export type EnquiryRow = {
  id: number;
  kind: string;
  status: string;
  fromName: string | null;
  fromEmail: string | null;
  fromPhone: string | null;
  fromCompany: string | null;
  fromUserId: number | null;
  about: string | null;
  subject: string | null;
  message: string;
  detail: Record<string, unknown> | null;
  note: string | null;
  handledAt: Date | null;
  handledByName: string | null;
  createdAt: Date;
};

function scoped(guard: Guarded) {
  return guard.isSuperadmin ? undefined : inArray(enquiries.siteId, guard.siteIds.length > 0 ? guard.siteIds : [-1]);
}

const columns = {
  enquiry: enquiries,
  handledByName: handler.name,
};

function toRow({ enquiry, handledByName }: { enquiry: typeof enquiries.$inferSelect; handledByName: string | null }): EnquiryRow {
  return {
    id: enquiry.id,
    kind: enquiry.kind,
    status: enquiry.status,
    fromName: enquiry.fromName,
    fromEmail: enquiry.fromEmail,
    fromPhone: enquiry.fromPhone,
    fromCompany: enquiry.fromCompany,
    fromUserId: enquiry.fromUserId,
    about: enquiry.about,
    subject: enquiry.subject,
    message: enquiry.message,
    detail: enquiry.detail,
    note: enquiry.note,
    handledAt: enquiry.handledAt,
    handledByName,
    createdAt: enquiry.createdAt,
  };
}

export async function listEnquiries(
  guard: Guarded,
  slug: string,
  query: { kind?: string; status?: string; q?: string; page?: number; perPage?: number },
  database: Database = db(),
): Promise<{
  rows: EnquiryRow[];
  total: number;
  page: number;
  per_page: number;
  counts: { new: number; handled: number; archived: number };
}> {
  const { page, perPage, offset } = paging(query);
  const [brand] = await database.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1);
  const inBrand = and(eq(enquiries.siteId, brand?.id ?? -1), scoped(guard));
  const words = query.q?.trim() ? `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const where = and(
    inBrand,
    query.kind ? eq(enquiries.kind, query.kind) : undefined,
    query.status ? eq(enquiries.status, query.status) : undefined,
    words
      ? or(
          ilike(enquiries.message, words),
          ilike(enquiries.subject, words),
          ilike(enquiries.fromName, words),
          ilike(enquiries.fromEmail, words),
          ilike(enquiries.fromCompany, words),
          ilike(enquiries.about, words),
        )
      : undefined,
  );

  const [[total], rows, byStatus] = await Promise.all([
    database.select({ n: count() }).from(enquiries).where(where),
    database
      .select(columns)
      .from(enquiries)
      .leftJoin(handler, eq(handler.id, enquiries.handledBy))
      .where(where)
      .orderBy(desc(enquiries.createdAt), desc(enquiries.id))
      .limit(perPage)
      .offset(offset),
    database
      .select({ status: enquiries.status, n: sql<number>`count(*)` })
      .from(enquiries)
      .where(inBrand)
      .groupBy(enquiries.status),
  ]);

  const counts = { new: 0, handled: 0, archived: 0 };

  for (const row of byStatus) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = Number(row.n);
    }
  }

  return { rows: rows.map(toRow), total: Number(total?.n ?? 0), page, per_page: perPage, counts };
}

export async function getEnquiry(guard: Guarded, id: number, database: Database = db()): Promise<EnquiryRow | null> {
  const [found] = await database
    .select(columns)
    .from(enquiries)
    .leftJoin(handler, eq(handler.id, enquiries.handledBy))
    .where(and(eq(enquiries.id, id), scoped(guard)))
    .limit(1);

  return found ? toRow(found) : null;
}

export async function setEnquiryStatus(
  guard: Guarded,
  id: number,
  status: "new" | "handled",
  note: string | null,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const [existing] = await database
    .select()
    .from(enquiries)
    .where(and(eq(enquiries.id, id), scoped(guard)))
    .limit(1);

  if (!existing) {
    return { ok: false, message: "That enquiry is not yours to change." };
  }

  const handled = status === "handled";

  await database
    .update(enquiries)
    .set({
      status,
      handledBy: handled ? guard.identity.user.id : null,
      handledAt: handled ? new Date() : null,
      // Reopening keeps what was written; marking handled may add to it.
      note: note?.trim() ? note.trim().slice(0, 2000) : existing.note,
    })
    .where(eq(enquiries.id, id));

  await database.insert(auditLog).values({
    siteId: existing.siteId,
    userId: guard.identity.user.id,
    action: handled ? "enquiry.handled" : "enquiry.reopened",
    entity: "enquiry",
    entityId: id,
    detail: { was: existing.status, note: note?.trim() || null },
    ip: context.ip ?? null,
  });

  return { ok: true };
}
