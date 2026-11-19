/**
 * The account and subscription emails the old sites sent, wired up again.
 *
 * Owner asked on 2026-11-19 for the carried-over system emails that nothing
 * sent to be sent. What the old sites did, read from their code
 * (RegisterController, HomeController::subscriptionPlans and ::freeTrialRequest):
 *
 * - **Welcome** (template 1) to the reader on registration, and an Admin
 *   Email to the brand's staff with the new reader's details. Sent here when
 *   the reader confirms their address, not the moment they register: the
 *   wording says "your account has been activated", and an address nobody
 *   has confirmed should not receive a brand's welcome.
 * - **Subscription Details** (template 2 or 3, by the reader's country) the
 *   first time a signed-in reader opens a brand's subscription page, with an
 *   Admin Email telling staff who is looking. The old sites remembered "first
 *   time" in a browser cookie; here it is the outbox itself, per reader and
 *   brand, so a second browser does not send it twice.
 * - An Admin Email when a reader asks for a free trial.
 *
 * Two things the old sites did that are not repeated:
 *
 * - The welcome mail carried the reader's password in plain text. Passwords
 *   are not kept in a form that can be sent, and should not be emailed, so
 *   `{password}` reads "the password you chose when you registered".
 * - "Trial usage exhausted" followed per-purchase download quotas, which the
 *   platform does not carry; trials end by date, and Trial Expired covers that.
 *
 * Every email here is the brand's own template: a brand that has switched one
 * off, or does not have it, gets nothing of that kind, as with the reminders.
 */

import { and, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { mailOutbox, mailTemplates, sites, users } from "@/db/schema";
import { brandSetting } from "@/domain/dashboard/settings";
import { preferredCurrency } from "@/domain/billing/pricing";
import { linkBaseFor } from "@/lib/mail/deliver";
import { detailsTable } from "@/lib/mail/details";
import { SYSTEM_PREFIX, fillPlaceholders } from "@/lib/mail/render";

type Row = typeof mailOutbox.$inferInsert;

/** The template's subject when the brand has it switched on, else null. */
async function enabledSubject(database: Database, siteId: number, key: string, variant: string): Promise<string | null> {
  const [row] = await database
    .select({ subject: mailTemplates.subject })
    .from(mailTemplates)
    .where(
      and(
        eq(mailTemplates.siteId, siteId),
        eq(mailTemplates.key, key),
        eq(mailTemplates.variant, variant),
        eq(mailTemplates.enabled, true),
      ),
    )
    .limit(1);

  return row ? row.subject : null;
}

async function loadPerson(database: Database, userId: number) {
  const [person] = await database.select().from(users).where(eq(users.id, userId)).limit(1);

  return person ?? null;
}

async function loadBrand(database: Database, siteId: number) {
  const [brand] = await database
    .select({ id: sites.id, name: sites.name, slug: sites.slug, domain: sites.legacyDomain })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);

  return brand ?? null;
}

/** The reader's details, the way every alert to staff lists them. */
function readerRows(person: NonNullable<Awaited<ReturnType<typeof loadPerson>>>): [string, unknown][] {
  return [
    ["Name", person.name],
    ["Email", person.email],
    ["Company", person.company],
    ["Phone", person.phone],
    ["City", person.city],
    ["Country", person.country],
  ];
}

/**
 * An Admin Email to the brand's admin address, or nothing when the brand has
 * none set or has the template off.
 */
async function staffAlert(
  database: Database,
  brand: { id: number; name: string },
  heading: string,
  subject: string,
  rows: [string, unknown][],
  replyTo: string | null,
): Promise<Row | null> {
  const [to, enabled] = await Promise.all([
    brandSetting(brand.id, "site_admin_email", database),
    enabledSubject(database, brand.id, "staff-alert", "default"),
  ]);

  if (!to || enabled === null) {
    return null;
  }

  return {
    siteId: brand.id,
    to: to.slice(0, 191),
    subject: subject.slice(0, 255),
    template: `${SYSTEM_PREFIX}staff-alert`,
    payload: {
      subject,
      vars: { heading, site: brand.name },
      html_vars: { content: detailsTable(rows) },
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
  };
}

/** A brand template addressed to the reader, or null when the brand has it off. */
async function toReader(
  database: Database,
  brand: { id: number },
  person: { id: number; email: string },
  key: string,
  variant: string,
  vars: Record<string, unknown>,
): Promise<Row | null> {
  // A brand without the regional wording falls back to its default one.
  let used = variant;
  let subject = await enabledSubject(database, brand.id, key, variant);

  if (subject === null && variant !== "default") {
    used = "default";
    subject = await enabledSubject(database, brand.id, key, "default");
  }

  if (subject === null) {
    return null;
  }

  return {
    siteId: brand.id,
    userId: person.id,
    to: person.email.slice(0, 191),
    // For the record only; filled again from the template at send time.
    subject: fillPlaceholders(subject, vars, false).slice(0, 255),
    template: `${SYSTEM_PREFIX}${key}`,
    payload: { vars, ...(used === "default" ? {} : { variant: used }) },
  };
}

async function queue(database: Database, rows: (Row | null)[]): Promise<number> {
  const ready = rows.filter((row): row is Row => row !== null);

  if (ready.length > 0) {
    await database.insert(mailOutbox).values(ready);
  }

  return ready.length;
}

/**
 * The reader confirmed their address: welcome them, and tell the brand's
 * staff about the new registration. Called once, by the caller that saw the
 * address go from unconfirmed to confirmed.
 */
export async function welcomeConfirmedReader(userId: number, siteId: number, database: Database = db()): Promise<number> {
  const [person, brand] = await Promise.all([loadPerson(database, userId), loadBrand(database, siteId)]);

  if (!person || !brand) {
    return 0;
  }

  const base = linkBaseFor(brand);

  return queue(database, [
    await toReader(database, brand, person, "welcome", "default", {
      name: person.name,
      email: person.email,
      password: "the password you chose when you registered",
      site: brand.name,
      weblink: base,
      trial_link: `${base}/subscription`,
    }),
    await staffAlert(
      database,
      brand,
      "New registration",
      `${brand.name} - New registration: ${person.name}`,
      readerRows(person),
      person.email,
    ),
  ]);
}

/**
 * A signed-in reader opened the brand's subscription page. The first time,
 * per reader and brand, they get the brand's Subscription Details (the rupee
 * wording for the subcontinent, the dollar one elsewhere) and staff hear who
 * is looking. Later visits send nothing.
 */
export async function subscriptionPageOpened(userId: number, siteId: number, database: Database = db()): Promise<number> {
  const [person, brand] = await Promise.all([loadPerson(database, userId), loadBrand(database, siteId)]);

  if (!person || !brand) {
    return 0;
  }

  // Both mails are worked out first, from reads only; the transaction below
  // is just the lock, the "sent before?" check and the insert.
  const variant = preferredCurrency(person.country) === "INR" ? "asia" : "default";
  const details = await toReader(database, brand, person, "subscription-details", variant, {
    name: person.name,
    email: person.email,
    site: brand.name,
  });

  // Without the reader's mail there is nothing to remember the visit by, so
  // staff are not told either: otherwise every visit would alert them again.
  if (!details) {
    return 0;
  }

  const alert = await staffAlert(
    database,
    brand,
    "A reader is looking at the subscription plans",
    `${brand.name} - Subscription interest: ${person.name}`,
    readerRows(person),
    person.email,
  );

  return database.transaction(async (tx) => {
    // Two tabs opening the page at once must not both send it.
    await tx.execute(sql`select pg_advisory_xact_lock(${userId}, ${siteId})`);

    const [already] = await tx
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.userId, userId),
          eq(mailOutbox.siteId, siteId),
          eq(mailOutbox.template, `${SYSTEM_PREFIX}subscription-details`),
        ),
      )
      .limit(1);

    if (already) {
      return 0;
    }

    const rows = alert ? [details, alert] : [details];

    await tx.insert(mailOutbox).values(rows);

    return rows.length;
  });
}

/** A reader asked for a free trial: tell the brand's staff, who decide it. */
export async function trialRequested(
  userId: number,
  siteId: number,
  note: string | null,
  database: Database = db(),
): Promise<number> {
  const [person, brand] = await Promise.all([loadPerson(database, userId), loadBrand(database, siteId)]);

  if (!person || !brand) {
    return 0;
  }

  return queue(database, [
    await staffAlert(
      database,
      brand,
      "Free trial request",
      `${brand.name} - Free trial request: ${person.name}`,
      [...readerRows(person), ["Note", note]],
      person.email,
    ),
  ]);
}
