/**
 * Queue a message. Nothing here sends one: `deliver.ts` does, from the
 * `mail.deliver` job, once a Brevo key is configured.
 *
 * Every outbound mail is written to `mail_outbox` and the endpoint answers
 * immediately. A request that must not fail because a mail server is slow
 * wants a queue anyway, and the newsletter and report-mailing screens will
 * queue into the same table. `template` must be one `render.ts` knows, or
 * the mail is failed rather than sent.
 *
 * The one-shot link goes in `payload`. In development that is also how you
 * read it back — `select payload from mail_outbox order by id desc limit 1`.
 */

import { db, type Database } from "@/db";
import { mailOutbox } from "@/db/schema";

export type Mail = {
  to: string;
  subject: string;
  template: string;
  payload?: Record<string, unknown>;
  siteId?: number | null;
  userId?: number | null;
};

export async function queueMail(mail: Mail, database: Database = db()): Promise<number> {
  const [row] = await database
    .insert(mailOutbox)
    .values({
      to: mail.to.slice(0, 191),
      subject: mail.subject.slice(0, 255),
      template: mail.template,
      payload: mail.payload ?? {},
      siteId: mail.siteId ?? null,
      userId: mail.userId ?? null,
    })
    .returning();

  return row!.id;
}
