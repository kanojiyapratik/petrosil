/**
 * Draining `mail_outbox`.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED` inside one UPDATE, which
 * does two jobs: two workers draining at once each get different rows, and
 * the claim pushes `next_attempt_at` forward as a lease, so a worker that
 * dies between claiming and sending hands the mail back ten minutes later
 * instead of stranding it. The attempt is counted at the claim, not after the
 * send, for the same reason: a crash still spends a try.
 *
 * The old sites called Brevo inline, one blocking request per recipient, and
 * logged a status of 400 for every mail whether it went or not. Here the
 * request that queued a mail has long since answered, and the row says what
 * actually happened.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { mailOutbox, mailTemplates, sites } from "@/db/schema";
import { renderMail, SYSTEM_PREFIX, TemplateUnavailable, UnknownTemplate, type StoredTemplate } from "./render";
import { SendError, type Transport } from "./transport";

/**
 * The brand's enabled template for a `system:` mail, read at send time so an
 * edit reaches mail still waiting in the queue. `payload.variant` picks a
 * regional edition; without one it is the default.
 */
async function storedTemplate(
  database: Database,
  mail: typeof mailOutbox.$inferSelect,
): Promise<StoredTemplate | null> {
  if (!mail.template.startsWith(SYSTEM_PREFIX) || mail.siteId === null) {
    return null;
  }

  const [found] = await database
    .select({ subject: mailTemplates.subject, body: mailTemplates.body })
    .from(mailTemplates)
    .where(
      and(
        eq(mailTemplates.siteId, mail.siteId),
        eq(mailTemplates.key, mail.template.slice(SYSTEM_PREFIX.length)),
        eq(mailTemplates.variant, String(mail.payload.variant ?? "default")),
        eq(mailTemplates.enabled, true),
      ),
    )
    .limit(1);

  return found ?? null;
}

export const MAX_ATTEMPTS = 5;

/** How long a claimed row is held before another worker may take it. */
const LEASE_MINUTES = 10;

/** The wait after the n-th failed attempt: 5 min, 15 min, 1 h, 4 h. */
export function retryDelayMinutes(attempt: number): number {
  const delays = [5, 15, 60, 240];

  return delays[Math.min(Math.max(attempt, 1), delays.length) - 1]!;
}

/**
 * Where a brand's links point. `MAIL_LINK_BASE` may carry `{domain}`, filled
 * with the brand's own domain; the default sends a reader to that domain.
 */
export function linkBaseFor(domain: string | null, env: Record<string, string | undefined> = process.env): string {
  const pattern = (env.MAIL_LINK_BASE ?? "").trim() || "https://{domain}";

  return pattern.replace("{domain}", domain || "petrosil.com").replace(/\/+$/, "");
}

export type DeliveryResult = { sent: number; retrying: number; failed: number };

async function databaseNow(database: Database): Promise<Date> {
  const [row] = (await database.execute(sql`select clock_timestamp() as now`)) as unknown as { now: Date | string }[];

  return new Date(row!.now);
}

export async function deliverPending(
  transport: Transport,
  options: { database?: Database; now?: Date; limit?: number; env?: Record<string, string | undefined> } = {},
): Promise<DeliveryResult> {
  const database = options.database ?? db();
  // The database's clock, not this process's: it stamped every time in the
  // queue, and judging those by a second clock lets any skew between the two
  // make a just-queued mail look not due. `now` is for tests moving time on.
  const now = options.now ?? (await databaseNow(database));
  const limit = options.limit ?? 50;
  const lease = new Date(now.getTime() + LEASE_MINUTES * 60_000);

  const claimed = (await database.execute(sql`
    update ${mailOutbox}
       set attempts = attempts + 1,
           next_attempt_at = ${lease.toISOString()}
     where id in (
       select id from ${mailOutbox}
        where sent_at is null
          and failed_at is null
          and next_attempt_at <= ${now.toISOString()}
        order by id
        limit ${limit}
        for update skip locked
     )
    returning id
  `)) as unknown as { id: number }[];

  const result: DeliveryResult = { sent: 0, retrying: 0, failed: 0 };

  if (claimed.length === 0) {
    return result;
  }

  const rows = await database
    .select({ mail: mailOutbox, siteName: sites.name, domain: sites.legacyDomain })
    .from(mailOutbox)
    .leftJoin(sites, eq(sites.id, mailOutbox.siteId))
    .where(
      inArray(
        mailOutbox.id,
        claimed.map((row) => row.id),
      ),
    )
    .orderBy(mailOutbox.id);

  for (const { mail, siteName, domain } of rows) {
    try {
      const rendered = renderMail(mail, {
        linkBase: linkBaseFor(domain, options.env),
        stored: await storedTemplate(database, mail),
      });
      const { messageId } = await transport.send({
        to: mail.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fromName: siteName ?? undefined,
        replyTo: typeof mail.payload.reply_to === "string" ? mail.payload.reply_to : undefined,
      });

      await database
        .update(mailOutbox)
        .set({ sentAt: now, providerMessageId: messageId, error: null })
        .where(eq(mailOutbox.id, mail.id));

      result.sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent =
        error instanceof UnknownTemplate ||
        error instanceof TemplateUnavailable ||
        (error instanceof SendError && error.permanent);

      if (permanent || mail.attempts >= MAX_ATTEMPTS) {
        await database
          .update(mailOutbox)
          .set({ failedAt: now, error: message.slice(0, 2000) })
          .where(eq(mailOutbox.id, mail.id));

        result.failed++;
      } else {
        await database
          .update(mailOutbox)
          .set({
            nextAttemptAt: new Date(now.getTime() + retryDelayMinutes(mail.attempts) * 60_000),
            error: message.slice(0, 2000),
          })
          .where(eq(mailOutbox.id, mail.id));

        result.retrying++;
      }
    }
  }

  return result;
}
