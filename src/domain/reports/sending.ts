/**
 * Mailing a report to the people who pay for it, sample reports to someone
 * who might, and the log of both.
 *
 * What the old sender got wrong, and what this does instead:
 * - It ran two loops of blocking Brevo calls inside one web request, so how
 *   far down the list the report got depended on PHP's time limit. Here every
 *   recipient is a queued mail, and the queue retries.
 * - From the second recipient on, everyone got the first one's personalised
 *   subject (the substitution reassigned the template). Each mail here is
 *   filled from the original.
 * - The recipient list came from the form. Here every ticked reader is checked
 *   against the brand's current paying readers, so an edited form cannot send
 *   a paid report to someone who has not paid.
 * - Its log said status 400 on every row. Here the log reads each mail's
 *   outbox row: queued, sent or failed, and why.
 * - Its open pixel for extra recipients resolved against the wrong table, so
 *   0 of 872 ever showed an open. Each recipient here has its own token.
 */

import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  auditLog,
  mailOutbox,
  mailSendRecipients,
  mailSends,
  mailTemplates,
  mediaFiles,
  memberships,
  reports,
  sites,
  users,
} from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import type { FileStore } from "@/lib/files/store";
import { brandSetting } from "@/domain/dashboard/settings";
import { today } from "@/domain/price/dates";

/** The old `country_mail` list: who gets the Asia edition of the sample mail. */
const ASIA = new Set(["afghanistan", "bangladesh", "bhutan", "india", "maldives", "nepal", "pakistan", "sri lanka"]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `{name}`, `{email}`, `{site}`, as the old send filled them; escaped for HTML when asked. */
function personalise(text: string, values: { name: string; email: string; site: string }, html: boolean): string {
  return text.replace(/\{(name|email|site)\}/g, (_whole, key: "name" | "email" | "site") =>
    html ? escape(values[key]) : values[key],
  );
}

/** Where the open pixel points: this platform, not a brand site. */
function appUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? "http://localhost:3100").replace(/\/+$/, "");
}

async function brandFor(guard: Pick<Guarded, "siteIds" | "isSuperadmin">, slug: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  return brand && (guard.isSuperadmin || guard.siteIds.includes(brand.id)) ? brand : null;
}

/* ------------------------------------------------------------ recipients */

export type Reader = { userId: number; name: string; email: string; company: string | null };

/** Current paying readers, and the brand's standing list of extra addresses. */
export async function reportRecipients(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  slug: string,
  database: Database = db(),
): Promise<{ readers: Reader[]; extra: string[] }> {
  const brand = await brandFor(guard, slug, database);

  if (!brand) {
    return { readers: [], extra: [] };
  }

  const readers = await database
    .select({ userId: users.id, name: users.name, email: users.email, company: users.company })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.siteId, brand.id),
        eq(memberships.role, "subscriber"),
        // Paying, not trying: the old send went to premium = 1 only.
        eq(memberships.tier, "premium"),
        // The last day belongs to the reader; no end date is open-ended.
        or(isNull(memberships.expiresAt), gte(memberships.expiresAt, today())),
        eq(users.status, "active"),
      ),
    )
    .orderBy(asc(users.name));

  const list = (await brandSetting(brand.id, "report_recipients", database)) ?? "";
  const extra = list
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter((address) => EMAIL.test(address));

  return { readers, extra };
}

/* ---------------------------------------------------------------- sending */

type Sent = { ok: true; id: number; recipients: number } | { ok: false; message: string };

/** A report's PDF as an attachment, or null when it has none in the store. */
async function attachmentFor(
  database: Database,
  store: FileStore,
  brand: { id: number; slug: string },
  report: typeof reports.$inferSelect,
): Promise<{ key: string; name: string } | null> {
  if (!report.file) {
    return null;
  }

  const [indexed] = await database
    .select({ path: mediaFiles.path, name: mediaFiles.name })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.siteId, brand.id), eq(mediaFiles.folder, "reports/files"), eq(mediaFiles.name, report.file)))
    .limit(1);

  return indexed && (await store.exists(indexed.path)) ? { key: indexed.path, name: indexed.name } : null;
}

async function queueSend(
  database: Database,
  guard: Guarded,
  input: {
    brand: { id: number; slug: string; name: string };
    kind: "report" | "sample";
    reports: (typeof reports.$inferSelect)[];
    attachments: { key: string; name: string }[];
    subject: string;
    body: string;
    to: { userId: number | null; name: string; email: string }[];
  },
  context: { ip?: string | null },
): Promise<{ id: number; recipients: number }> {
  return database.transaction(async (tx) => {
    const [send] = await tx
      .insert(mailSends)
      .values({
        siteId: input.brand.id,
        kind: input.kind,
        reportIds: input.reports.map((report) => report.id),
        about: input.reports.map((report) => report.title).join(" · ").slice(0, 512),
        subject: input.subject.slice(0, 255),
        body: input.body,
        sentBy: guard.identity.user.id,
      })
      .returning({ id: mailSends.id });

    for (const person of input.to) {
      const token = randomBytes(24).toString("base64url");
      const values = { name: person.name, email: person.email, site: input.brand.name };
      const html =
        personalise(input.body, values, true) +
        `<img src="${appUrl()}/api/public/open/${token}" width="1" height="1" alt="" style="display:block;border:0" />`;

      const [mail] = await tx
        .insert(mailOutbox)
        .values({
          siteId: input.brand.id,
          userId: person.userId,
          to: person.email.slice(0, 191),
          subject: personalise(input.subject, values, false).slice(0, 255),
          template: "prepared",
          payload: { html, attachments: input.attachments, send: send!.id },
        })
        .returning({ id: mailOutbox.id });

      await tx.insert(mailSendRecipients).values({
        sendId: send!.id,
        userId: person.userId,
        email: person.email.slice(0, 191),
        name: person.name.slice(0, 191) || null,
        outboxId: mail!.id,
        openToken: token,
      });
    }

    await tx.insert(auditLog).values({
      siteId: input.brand.id,
      userId: guard.identity.user.id,
      action: input.kind === "report" ? "report.send" : "report.sample",
      entity: "mail_send",
      entityId: send!.id,
      detail: { reports: input.reports.map((report) => report.id), recipients: input.to.length },
      ip: context.ip ?? null,
    });

    return { id: send!.id, recipients: input.to.length };
  });
}

export async function sendReport(
  guard: Guarded,
  input: { site: string; reportId: number; subject: string; body: string; userIds: number[]; extra: string[] },
  store: FileStore,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Sent> {
  const brand = await brandFor(guard, input.site, database);

  if (!brand) {
    return { ok: false, message: "That brand is not yours to send from." };
  }

  const [report] = await database
    .select()
    .from(reports)
    .where(and(eq(reports.id, input.reportId), eq(reports.siteId, brand.id), isNull(reports.deletedAt)))
    .limit(1);

  if (!report) {
    return { ok: false, message: "That report is not one of this brand's." };
  }

  const attachment = await attachmentFor(database, store, brand, report);

  if (!attachment) {
    return { ok: false, message: "This report has no PDF in the file store, so there is nothing to send." };
  }

  const subject = input.subject.trim();
  const body = input.body.trim();

  if (!subject || !body) {
    return { ok: false, message: "Write a subject and a message." };
  }

  // Ticked readers must be paying readers now, whatever the form said.
  const { readers } = await reportRecipients(guard, input.site, database);
  const paying = new Map(readers.map((reader) => [reader.userId, reader]));
  const strangers = input.userIds.filter((id) => !paying.has(id));

  if (strangers.length > 0) {
    return { ok: false, message: "Some of the people ticked are not paying readers of this brand." };
  }

  const seen = new Set<string>();
  const to: { userId: number | null; name: string; email: string }[] = [];

  for (const id of input.userIds) {
    const reader = paying.get(id)!;
    const key = reader.email.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      to.push({ userId: reader.userId, name: reader.name, email: reader.email });
    }
  }

  for (const address of input.extra.map((value) => value.trim()).filter(Boolean)) {
    if (!EMAIL.test(address)) {
      return { ok: false, message: `"${address}" is not an email address.` };
    }

    if (!seen.has(address.toLowerCase())) {
      seen.add(address.toLowerCase());
      to.push({ userId: null, name: "", email: address });
    }
  }

  if (to.length === 0) {
    return { ok: false, message: "Tick at least one reader or add an address." };
  }

  const queued = await queueSend(
    database,
    guard,
    { brand, kind: "report", reports: [report], attachments: [attachment], subject, body, to },
    context,
  );

  return { ok: true, ...queued };
}

export async function sendSample(
  guard: Guarded,
  input: { site: string; userId: number; reportIds: number[]; subject?: string; body?: string },
  store: FileStore,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<Sent> {
  const brand = await brandFor(guard, input.site, database);

  if (!brand) {
    return { ok: false, message: "That brand is not yours to send from." };
  }

  const [person] = await database
    .select({ id: users.id, name: users.name, email: users.email, country: users.country, status: users.status })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.siteId, brand.id)))
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!person || person.status !== "active") {
    return { ok: false, message: "Choose a reader of this brand." };
  }

  const ids = [...new Set(input.reportIds)];

  if (ids.length === 0 || ids.length > 5) {
    return { ok: false, message: "Choose between one and five reports." };
  }

  const chosen = await database
    .select()
    .from(reports)
    .where(and(inArray(reports.id, ids), eq(reports.siteId, brand.id), isNull(reports.deletedAt)));

  if (chosen.length !== ids.length) {
    return { ok: false, message: "Every report must be one of this brand's." };
  }

  // Attach in the order chosen.
  const ordered = ids.map((id) => chosen.find((report) => report.id === id)!);
  const attachments: { key: string; name: string }[] = [];

  for (const report of ordered) {
    const attachment = await attachmentFor(database, store, brand, report);

    if (!attachment) {
      return { ok: false, message: `"${report.title}" has no PDF in the file store.` };
    }

    attachments.push(attachment);
  }

  const variant = ASIA.has((person.country ?? "").trim().toLowerCase()) ? "asia" : "default";
  const [template] = await database
    .select()
    .from(mailTemplates)
    .where(
      and(
        eq(mailTemplates.siteId, brand.id),
        eq(mailTemplates.key, "sample-reports"),
        eq(mailTemplates.variant, variant),
        eq(mailTemplates.enabled, true),
      ),
    )
    .limit(1);

  const subject = input.subject?.trim() || template?.subject;
  const body = input.body?.trim() || template?.body;

  if (!subject || !body) {
    return { ok: false, message: "This brand has no sample-reports mail switched on, and none was written." };
  }

  const queued = await queueSend(
    database,
    guard,
    {
      brand,
      kind: "sample",
      reports: ordered,
      attachments,
      subject,
      body,
      to: [{ userId: person.id, name: person.name, email: person.email }],
    },
    context,
  );

  return { ok: true, ...queued };
}

/* ------------------------------------------------------------------ opens */

/** Record the first open for a token. True when the token is one of ours. */
export async function recordOpen(token: string, database: Database = db()): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    return false;
  }

  const [known] = await database
    .select({ id: mailSendRecipients.id, openedAt: mailSendRecipients.openedAt })
    .from(mailSendRecipients)
    .where(eq(mailSendRecipients.openToken, token))
    .limit(1);

  if (!known) {
    return false;
  }

  if (!known.openedAt) {
    await database
      .update(mailSendRecipients)
      .set({ openedAt: new Date() })
      .where(and(eq(mailSendRecipients.id, known.id), isNull(mailSendRecipients.openedAt)));
  }

  return true;
}

/* -------------------------------------------------------------------- log */

export type SendRow = {
  id: number;
  kind: string;
  about: string | null;
  subject: string;
  sentByName: string | null;
  legacy: boolean;
  createdAt: Date;
  recipients: number;
  sent: number;
  failed: number;
  opened: number;
};

export async function listSends(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  slug: string,
  query: { kind?: string; page?: number },
  database: Database = db(),
): Promise<{ rows: SendRow[]; total: number; page: number; per_page: number }> {
  const brand = await brandFor(guard, slug, database);
  const perPage = 25;
  const page = Math.max(1, Math.trunc(query.page ?? 1));

  if (!brand) {
    return { rows: [], total: 0, page, per_page: perPage };
  }

  const where = and(eq(mailSends.siteId, brand.id), query.kind ? eq(mailSends.kind, query.kind) : undefined);

  const [[total], rows] = await Promise.all([
    database.select({ n: count() }).from(mailSends).where(where),
    database
      .select({
        send: mailSends,
        sentByName: users.name,
        recipients: sql<number>`(select count(*) from ${mailSendRecipients} r where r.send_id = ${mailSends.id})`,
        sent: sql<number>`(select count(*) from ${mailSendRecipients} r join ${mailOutbox} o on o.id = r.outbox_id where r.send_id = ${mailSends.id} and o.sent_at is not null)`,
        failed: sql<number>`(select count(*) from ${mailSendRecipients} r join ${mailOutbox} o on o.id = r.outbox_id where r.send_id = ${mailSends.id} and o.failed_at is not null)`,
        opened: sql<number>`(select count(*) from ${mailSendRecipients} r where r.send_id = ${mailSends.id} and r.opened_at is not null)`,
      })
      .from(mailSends)
      .leftJoin(users, eq(users.id, mailSends.sentBy))
      .where(where)
      .orderBy(desc(mailSends.createdAt), desc(mailSends.id))
      .limit(perPage)
      .offset((page - 1) * perPage),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.send.id,
      kind: row.send.kind,
      about: row.send.about,
      subject: row.send.subject,
      sentByName: row.sentByName,
      legacy: row.send.legacy,
      createdAt: row.send.createdAt,
      recipients: Number(row.recipients),
      sent: Number(row.sent),
      failed: Number(row.failed),
      opened: Number(row.opened),
    })),
    total: Number(total?.n ?? 0),
    page,
    per_page: perPage,
  };
}

export type RecipientRow = {
  email: string;
  name: string | null;
  status: "queued" | "sent" | "failed" | "old site" | "unknown";
  error: string | null;
  sentAt: Date | null;
  openedAt: Date | null;
};

export type SendDetail = Omit<SendRow, "recipients"> & {
  body: string;
  site: string;
  recipients: RecipientRow[];
};

export async function getSend(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  id: number,
  database: Database = db(),
): Promise<SendDetail | null> {
  const [found] = await database
    .select({ send: mailSends, site: sites.slug, sentByName: users.name })
    .from(mailSends)
    .innerJoin(sites, eq(sites.id, mailSends.siteId))
    .leftJoin(users, eq(users.id, mailSends.sentBy))
    .where(eq(mailSends.id, id))
    .limit(1);

  if (!found || !(guard.isSuperadmin || guard.siteIds.includes(found.send.siteId))) {
    return null;
  }

  const people = await database
    .select({ recipient: mailSendRecipients, mail: mailOutbox })
    .from(mailSendRecipients)
    .leftJoin(mailOutbox, eq(mailOutbox.id, mailSendRecipients.outboxId))
    .where(eq(mailSendRecipients.sendId, id))
    .orderBy(asc(mailSendRecipients.id));

  const recipients: RecipientRow[] = people.map(({ recipient, mail }) => ({
    email: recipient.email,
    name: recipient.name,
    status: found.send.legacy
      ? "old site"
      : !mail
        ? "unknown"
        : mail.sentAt
          ? "sent"
          : mail.failedAt
            ? "failed"
            : "queued",
    error: mail?.error ?? null,
    sentAt: mail?.sentAt ?? null,
    openedAt: recipient.openedAt,
  }));

  const counted = (status: RecipientRow["status"]) => recipients.filter((row) => row.status === status).length;

  return {
    id: found.send.id,
    kind: found.send.kind,
    about: found.send.about,
    subject: found.send.subject,
    body: found.send.body,
    site: found.site,
    sentByName: found.sentByName,
    legacy: found.send.legacy,
    createdAt: found.send.createdAt,
    recipients,
    sent: counted("sent"),
    failed: counted("failed"),
    opened: recipients.filter((row) => row.openedAt !== null).length,
  };
}

/* ------------------------------------------------------------ the forms */

const FALLBACK_BODY = "<p>Dear {name},</p><p>Please find the latest {site} report attached.</p>";

/**
 * What the send screen starts from: the report, whether its PDF is in the
 * store, the brand's send-report wording, and every paying reader (ticked).
 * The template's own subject on every brand is "Send Report", which says
 * nothing to a reader, so the report's title is used instead.
 */
export async function reportSendForm(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  slug: string,
  reportId: number,
  store: FileStore,
  database: Database = db(),
): Promise<{
  report: { id: number; title: string; file: string | null };
  hasPdf: boolean;
  subject: string;
  body: string;
  readers: Reader[];
  extra: string[];
} | null> {
  const brand = await brandFor(guard, slug, database);

  if (!brand) {
    return null;
  }

  const [report] = await database
    .select()
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.siteId, brand.id), isNull(reports.deletedAt)))
    .limit(1);

  if (!report) {
    return null;
  }

  const [template] = await database
    .select({ body: mailTemplates.body })
    .from(mailTemplates)
    .where(and(eq(mailTemplates.siteId, brand.id), eq(mailTemplates.key, "send-report"), eq(mailTemplates.enabled, true)))
    .limit(1);

  const { readers, extra } = await reportRecipients(guard, slug, database);

  return {
    report: { id: report.id, title: report.title, file: report.file },
    hasPdf: (await attachmentFor(database, store, brand, report)) !== null,
    subject: report.title,
    body: template?.body?.trim() ? template.body : FALLBACK_BODY,
    readers,
    extra,
  };
}

/** A brand's readers matching a name, company or email — anyone, paying or not: a sample is for prospects. */
export async function findReaders(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  slug: string,
  q: string,
  database: Database = db(),
): Promise<(Reader & { tier: string; country: string | null })[]> {
  const brand = await brandFor(guard, slug, database);
  const words = q.trim();

  if (!brand || words.length < 2) {
    return [];
  }

  const like = `%${words.replace(/[\%_]/g, (c) => `\${c}`)}%`;

  return database
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      company: users.company,
      tier: memberships.tier,
      country: users.country,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.siteId, brand.id),
        eq(memberships.role, "subscriber"),
        eq(users.status, "active"),
        or(ilike(users.name, like), ilike(users.email, like), ilike(users.company, like)),
      ),
    )
    .orderBy(asc(users.name))
    .limit(25);
}

/** The brand's reports that have their PDF in the store, newest first. */
export async function sendableReports(
  guard: Pick<Guarded, "siteIds" | "isSuperadmin">,
  slug: string,
  store: FileStore,
  database: Database = db(),
  limit = 30,
): Promise<{ id: number; title: string; file: string; createdAt: Date }[]> {
  const brand = await brandFor(guard, slug, database);

  if (!brand) {
    return [];
  }

  const rows = await database
    .select({ id: reports.id, title: reports.title, file: reports.file, createdAt: reports.createdAt, path: mediaFiles.path })
    .from(reports)
    .innerJoin(
      mediaFiles,
      and(eq(mediaFiles.siteId, reports.siteId), eq(mediaFiles.folder, "reports/files"), eq(mediaFiles.name, reports.file)),
    )
    .where(and(eq(reports.siteId, brand.id), isNull(reports.deletedAt)))
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(limit);

  const present: { id: number; title: string; file: string; createdAt: Date }[] = [];

  for (const row of rows) {
    if (await store.exists(row.path)) {
      present.push({ id: row.id, title: row.title, file: row.file!, createdAt: row.createdAt });
    }
  }

  return present;
}
