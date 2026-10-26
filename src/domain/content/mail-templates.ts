/**
 * The system mail templates, as staff see and edit them.
 *
 * Edit-only, like the old screen: the set is fixed by what the code sends, so
 * there is nothing to create, and switching a template off is how a brand
 * stops a mail. The old list showed a title and an Edit button; this one also
 * says what sends each template, because six of the twelve are sent by
 * nothing yet and staff should not polish a mail no one receives.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, mailTemplates, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";

/** The placeholders the reminder job fills (see domain/billing/reminders.ts). */
const REMINDER_FIELDS = ["name", "email", "site", "link", "day", "expiry_date", "price", "currency_symbol"];

/**
 * What sends each key, and what it fills. A key absent here has no sender
 * yet, so there is nothing to check its placeholders against.
 */
const SENDERS: Record<string, { sentBy: string; fields: string[] }> = {
  "trial-expiring": { sentBy: "Trial reminders, daily at 10:00", fields: REMINDER_FIELDS },
  "trial-expired": { sentBy: "Trial reminders, daily at 10:00", fields: REMINDER_FIELDS },
  "subscription-expiring": { sentBy: "Renewal reminders, daily at 10:00", fields: REMINDER_FIELDS },
  "subscription-expired": { sentBy: "Renewal reminders, daily at 10:00", fields: REMINDER_FIELDS },
};

export type MailTemplateRow = {
  id: number;
  site: string;
  key: string;
  variant: string;
  title: string;
  subject: string;
  body: string;
  enabled: boolean;
  updatedAt: Date;
  sentBy: string | null;
  fields: string[];
};

export async function listMailTemplates(
  guard: Guarded,
  slug: string,
  database: Database = db(),
): Promise<MailTemplateRow[]> {
  const scope = guard.isSuperadmin ? undefined : inArray(sites.id, guard.siteIds.length > 0 ? guard.siteIds : [-1]);

  const rows = await database
    .select({ template: mailTemplates, site: sites.slug })
    .from(mailTemplates)
    .innerJoin(sites, eq(sites.id, mailTemplates.siteId))
    .where(and(eq(sites.slug, slug), scope))
    .orderBy(asc(mailTemplates.key), asc(mailTemplates.variant));

  return rows.map(({ template, site }) => ({
    id: template.id,
    site,
    key: template.key,
    variant: template.variant,
    title: template.title,
    subject: template.subject,
    body: template.body,
    enabled: template.enabled,
    updatedAt: template.updatedAt,
    sentBy: SENDERS[template.key]?.sentBy ?? null,
    fields: SENDERS[template.key]?.fields ?? [],
  }));
}

export type MailTemplateSaved = { ok: true; unknown: string[] } | { ok: false; message: string; field: string };

export async function saveMailTemplate(
  guard: Guarded,
  input: { id: number; subject: string; body: string; enabled: boolean },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<MailTemplateSaved> {
  const subject = String(input.subject ?? "").trim();
  const body = String(input.body ?? "").trim();

  if (subject === "") {
    return { ok: false, message: "A mail needs a subject.", field: "subject" };
  }

  if (body === "") {
    return { ok: false, message: "A mail needs something to say.", field: "body" };
  }

  const [existing] = await database.select().from(mailTemplates).where(eq(mailTemplates.id, input.id)).limit(1);

  // Naming an id does not grant access to it: another brand's template is
  // refused exactly as if it did not exist.
  if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
    return { ok: false, message: "That template is not yours to change.", field: "id" };
  }

  await database
    .update(mailTemplates)
    .set({ subject: subject.slice(0, 255), body, enabled: input.enabled, updatedAt: new Date() })
    .where(eq(mailTemplates.id, existing.id));

  await database.insert(auditLog).values({
    siteId: existing.siteId,
    userId: guard.identity.user.id,
    action: "mail_template.save",
    entity: "mail_template",
    entityId: existing.id,
    detail: {
      key: existing.key,
      variant: existing.variant,
      enabled: input.enabled,
      subject_changed: subject !== existing.subject,
      body_changed: body !== existing.body,
    },
    ip: context.ip ?? null,
  });

  // Saved either way; an unfilled placeholder would reach readers as "{prise}",
  // so it is named back to whoever typed it.
  const known = SENDERS[existing.key]?.fields;
  const used = [...`${subject} ${body}`.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]!);
  const unknown = known ? [...new Set(used.filter((name) => !known.includes(name)))] : [];

  return { ok: true, unknown };
}
