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

import { eq, inArray, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { mailOutbox, sites } from "@/db/schema";
import { renderMail, UnknownTemplate } from "./render";
import { SendError, type Transport } from "./transport";

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

export async function deliverPending(
  transport: Transport,
  options: { database?: Database; now?: Date; limit?: number; env?: Record<string, string | undefined> } = {},
): Promise<DeliveryResult> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
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
      const rendered = renderMail(mail, { linkBase: linkBaseFor(domain, options.env) });
      const { messageId } = await transport.send({
        to: mail.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fromName: siteName ?? undefined,
      });

      await database
        .update(mailOutbox)
        .set({ sentAt: now, providerMessageId: messageId, error: null })
        .where(eq(mailOutbox.id, mail.id));

      result.sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent =
        error instanceof UnknownTemplate || (error instanceof SendError && error.permanent);

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
