/**
 * Sending a newsletter issue to a brand's own subscribers, and letting them stop.
 *
 * The old screen handed each issue to one of five mailing services (Brevo list
 * 9, Mailchimp, GetResponse, MailWizz, SendGrid), with live keys in the source,
 * and kept no record of what went: no status change and no count. Here:
 *
 * - The list is the brand's own readers in this database: every active
 *   subscriber, only the paying ones, or only the free and trial ones. Staff
 *   choose before sending.
 * - Anyone who used the unsubscribe link in an earlier issue, or whom staff
 *   took off, is left out. Each copy carries its reader's own link, and the
 *   List-Unsubscribe headers, so a mail client's own button works as well.
 * - Staff confirm by typing the number of people it will go to. A list that
 *   has changed since the popup opened is refused, so nobody sends to 20,000
 *   while thinking it is 77.
 * - The issue becomes "sent" in the same transaction that queues its mails, and
 *   only from "draft", so a double click or a second tab cannot send it twice.
 * - Every copy is a queued mail on the same send record as report mailings, so
 *   "did it go, and to how many" has an answer: queued, sent, failed, opened.
 *
 * The body is not copied into every queued row (a 30 KB issue × 20,000 readers
 * would be 600 MB). Delivery reads it from the send record.
 */

import { randomBytes } from "node:crypto";
import { and, eq, gte, isNull, not, or, sql, type SQL } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  auditLog,
  mailOutbox,
  mailSendRecipients,
  mailSends,
  memberships,
  newsletterOptOuts,
  newsletters,
  sites,
  users,
} from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { requirePermission } from "@/domain/staff/permissions";
import { today } from "@/domain/price/dates";
import { getNewsletter } from "./newsletters";

export const AUDIENCES = {
  everyone: "Every subscriber",
  paying: "Paying readers only",
  free: "Free and trial readers only",
} as const;

export type Audience = keyof typeof AUDIENCES;

const isAudience = (value: string): value is Audience => value in AUDIENCES;

/** Where the unsubscribe page and the open pixel live: this platform. */
function appUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.PUBLIC_APP_URL ?? "http://localhost:3100").trim().replace(/\/+$/, "");
}

/** Paying now: premium, and the end date (if any) not passed. */
function paying(): SQL {
  return and(
    eq(memberships.tier, "premium"),
    or(isNull(memberships.expiresAt), gte(memberships.expiresAt, today())),
  )!;
}

/**
 * Who an audience is on one brand: its active subscribers with a usable
 * address who have not opted out of its newsletter.
 */
function audienceWhere(siteId: number, audience: Audience): SQL {
  return and(
    eq(memberships.siteId, siteId),
    eq(memberships.role, "subscriber"),
    eq(users.status, "active"),
    sql`${users.email} like '%_@_%._%'`,
    sql`not exists (select 1 from ${newsletterOptOuts} o where o.site_id = ${siteId} and o.email = lower(${users.email}))`,
    audience === "paying" ? paying() : audience === "free" ? not(paying()) : undefined,
  )!;
}

export type AudienceCounts = Record<Audience, number> & { optedOut: number };

/** How many each choice would reach now, and how many have opted out. */
export async function audienceCounts(
  guard: Guarded,
  newsletterId: number,
  database: Database = db(),
): Promise<AudienceCounts | null> {
  const issue = await getNewsletter(guard, newsletterId, database);

  if (!issue) {
    return null;
  }

  const counted = async (audience: Audience) => {
    const [row] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(audienceWhere(issue.siteId, audience));

    return row?.n ?? 0;
  };

  const [everyone, payingCount, free, [opted]] = await Promise.all([
    counted("everyone"),
    counted("paying"),
    counted("free"),
    database
      .select({ n: sql<number>`count(*)::int` })
      .from(newsletterOptOuts)
      .where(eq(newsletterOptOuts.siteId, issue.siteId)),
  ]);

  return { everyone, paying: payingCount, free, optedOut: opted?.n ?? 0 };
}

export type NewsletterSent = { ok: true; recipients: number; sendId: number } | { ok: false; message: string };

const CHUNK = 500;

export async function sendNewsletter(
  guard: Guarded,
  input: { id: number; audience: string; confirm: string | number },
  context: { ip?: string | null; env?: Record<string, string | undefined> } = {},
  database: Database = db(),
): Promise<NewsletterSent> {
  const issue = await getNewsletter(guard, input.id, database);

  if (!issue) {
    return { ok: false, message: "That issue is not yours to send." };
  }

  await requirePermission(guard, issue.siteId, "newsletter-send", database);

  if (issue.status !== "draft") {
    return { ok: false, message: "Only a draft can be sent. Copy this issue into a new draft to send it again." };
  }

  if (!isAudience(input.audience)) {
    return { ok: false, message: "Choose who it goes to." };
  }

  const people = await database
    .select({ userId: users.id, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(audienceWhere(issue.siteId, input.audience))
    .orderBy(users.id);

  if (people.length === 0) {
    return { ok: false, message: "Nobody is on that list, so there is no one to send it to." };
  }

  const typed = Number(String(input.confirm ?? "").replace(/[\s,]/g, ""));

  if (typed !== people.length) {
    return {
      ok: false,
      message: `To send, type the number of people it goes to: ${people.length.toLocaleString("en-GB")}.`,
    };
  }

  const app = appUrl(context.env);
  const [brand] = await database.select({ name: sites.name }).from(sites).where(eq(sites.id, issue.siteId)).limit(1);

  return database.transaction(async (tx) => {
    // The claim: only a draft becomes sent, so a second click finds nothing.
    const [claimed] = await tx
      .update(newsletters)
      .set({ status: "sent", sentAt: new Date(), recipients: people.length, updatedAt: new Date() })
      .where(and(eq(newsletters.id, issue.id), eq(newsletters.status, "draft")))
      .returning({ id: newsletters.id });

    if (!claimed) {
      return { ok: false, message: "This issue has just been sent." } as const;
    }

    const [send] = await tx
      .insert(mailSends)
      .values({
        siteId: issue.siteId,
        kind: "newsletter",
        newsletterId: issue.id,
        about: issue.title.slice(0, 512),
        subject: issue.title.slice(0, 255),
        body: issue.body,
        sentBy: guard.identity.user.id,
      })
      .returning({ id: mailSends.id });

    for (let start = 0; start < people.length; start += CHUNK) {
      const chunk = people.slice(start, start + CHUNK).map((person) => ({
        ...person,
        token: randomBytes(24).toString("base64url"),
      }));

      const queued = await tx
        .insert(mailOutbox)
        .values(
          chunk.map((person) => ({
            siteId: issue.siteId,
            userId: person.userId,
            to: person.email.slice(0, 191),
            subject: issue.title.slice(0, 255),
            template: "newsletter",
            payload: {
              send: send!.id,
              siteName: brand?.name ?? issue.siteName,
              unsubscribe: `${app}/unsubscribe/${person.token}`,
              one_click: `${app}/api/public/unsubscribe/${person.token}`,
              pixel: `${app}/api/public/open/${person.token}`,
            },
          })),
        )
        .returning({ id: mailOutbox.id, userId: mailOutbox.userId });

      // Matched back by user: one membership per user per brand, so one mail each.
      const outboxFor = new Map(queued.map((row) => [row.userId, row.id]));

      await tx.insert(mailSendRecipients).values(
        chunk.map((person) => ({
          sendId: send!.id,
          userId: person.userId,
          email: person.email.slice(0, 191),
          name: person.name.slice(0, 191) || null,
          outboxId: outboxFor.get(person.userId) ?? null,
          openToken: person.token,
        })),
      );
    }

    await tx.insert(auditLog).values({
      siteId: issue.siteId,
      userId: guard.identity.user.id,
      action: "newsletter.send",
      entity: "newsletter",
      entityId: issue.id,
      detail: { audience: input.audience, recipients: people.length, send: send!.id },
      ip: context.ip ?? null,
    });

    return { ok: true, recipients: people.length, sendId: send!.id } as const;
  });
}

/* ------------------------------------------------------------ delivery */

export type NewsletterDelivery = {
  sendId: number;
  recipients: number;
  sent: number;
  failed: number;
  waiting: number;
  opened: number;
  optedOut: number;
};

/** What became of a sent issue's mails, read from the outbox. */
export async function newsletterDelivery(
  guard: Guarded,
  newsletterId: number,
  database: Database = db(),
): Promise<NewsletterDelivery | null> {
  const issue = await getNewsletter(guard, newsletterId, database);

  if (!issue) {
    return null;
  }

  const [send] = await database
    .select({ id: mailSends.id })
    .from(mailSends)
    .where(and(eq(mailSends.newsletterId, issue.id), eq(mailSends.kind, "newsletter")))
    .limit(1);

  if (!send) {
    return null;
  }

  const [row] = await database
    .select({
      recipients: sql<number>`count(*)::int`,
      sent: sql<number>`count(${mailOutbox.sentAt})::int`,
      failed: sql<number>`count(${mailOutbox.failedAt})::int`,
      opened: sql<number>`count(${mailSendRecipients.openedAt})::int`,
    })
    .from(mailSendRecipients)
    .leftJoin(mailOutbox, eq(mailOutbox.id, mailSendRecipients.outboxId))
    .where(eq(mailSendRecipients.sendId, send.id));

  const [opted] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(newsletterOptOuts)
    .innerJoin(mailSendRecipients, sql`lower(${mailSendRecipients.email}) = ${newsletterOptOuts.email}`)
    .where(
      and(
        eq(mailSendRecipients.sendId, send.id),
        eq(newsletterOptOuts.siteId, issue.siteId),
        eq(newsletterOptOuts.source, "link"),
      ),
    );

  const recipients = row?.recipients ?? 0;
  const sent = row?.sent ?? 0;
  const failed = row?.failed ?? 0;

  return {
    sendId: send.id,
    recipients,
    sent,
    failed,
    waiting: recipients - sent - failed,
    opened: row?.opened ?? 0,
    optedOut: opted?.n ?? 0,
  };
}

/* --------------------------------------------------------- unsubscribing */

export type Unsubscribe = { email: string; siteName: string; optedOut: boolean };

async function recipientFor(token: string, database: Database) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return null;
  }

  const [found] = await database
    .select({ email: mailSendRecipients.email, siteId: mailSends.siteId, siteName: sites.name, kind: mailSends.kind })
    .from(mailSendRecipients)
    .innerJoin(mailSends, eq(mailSends.id, mailSendRecipients.sendId))
    .innerJoin(sites, eq(sites.id, mailSends.siteId))
    .where(eq(mailSendRecipients.openToken, token))
    .limit(1);

  // Only a newsletter's link unsubscribes: a report mail's open token is not one.
  return found && found.kind === "newsletter" ? found : null;
}

/** Whose link this is, and whether they are already off the list. Null for a link that is not one. */
export async function lookUpUnsubscribe(token: string, database: Database = db()): Promise<Unsubscribe | null> {
  const found = await recipientFor(token, database);

  if (!found) {
    return null;
  }

  const [opted] = await database
    .select({ id: newsletterOptOuts.id })
    .from(newsletterOptOuts)
    .where(and(eq(newsletterOptOuts.siteId, found.siteId), eq(newsletterOptOuts.email, found.email.toLowerCase())))
    .limit(1);

  return { email: found.email, siteName: found.siteName, optedOut: Boolean(opted) };
}

/** Take the link's address off its brand's newsletter, or (`again`) put it back. */
export async function setUnsubscribed(
  token: string,
  unsubscribed: boolean,
  database: Database = db(),
): Promise<Unsubscribe | null> {
  const found = await recipientFor(token, database);

  if (!found) {
    return null;
  }

  const email = found.email.toLowerCase();

  if (unsubscribed) {
    await database
      .insert(newsletterOptOuts)
      .values({ siteId: found.siteId, email, source: "link" })
      .onConflictDoNothing();
  } else {
    await database
      .delete(newsletterOptOuts)
      .where(and(eq(newsletterOptOuts.siteId, found.siteId), eq(newsletterOptOuts.email, email)));
  }

  return { email: found.email, siteName: found.siteName, optedOut: unsubscribed };
}
