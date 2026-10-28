/**
 * A brand's mail: how it leaves, who it is from, and the old credentials.
 *
 * Mail leaves through the estate's one Brevo account (BREVO_API_KEY and
 * MAIL_FROM, in the environment — a key is not something to keep in a table
 * an admin screen can read). Each old site instead carried its own SMTP login
 * in its settings table: eight of the nine the same SendGrid key, in
 * plaintext, on a screen anyone with the admin flag could open. Those came
 * across and nothing reads them; this screen says so and can delete them.
 *
 * What a brand does choose is its sender. The old sites mailed from their own
 * address, and readers know them by it. A provider refuses a sender it has
 * not verified, and refuses it permanently, so a brand's address is used only
 * once a test mail from it has gone through — `mail_from_confirmed` holds the
 * address that passed, and changing the address leaves it unconfirmed until
 * it is tested again. Until then mail goes from the estate's address, under
 * the brand's name, as it does now.
 */

import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, mailOutbox, settings, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { SendError, transportFromEnv, type Transport } from "@/lib/mail/transport";

/** The old sites' SMTP login, carried over and read by nothing. */
export const OLD_CREDENTIALS = [
  { key: "mail_transport", label: "Sent by" },
  { key: "smtp_host", label: "SMTP host" },
  { key: "smtp_port", label: "SMTP port" },
  { key: "smtp_username", label: "SMTP username" },
  { key: "smtp_password", label: "SMTP password", secret: true },
] as const;

const SENDER_KEYS = ["mail_from_address", "mail_reply_to", "mail_from_confirmed"] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BrandSender = {
  /** The brand's own address, set or not, confirmed or not. */
  fromAddress: string | null;
  confirmed: boolean;
  replyTo: string | null;
};

export type BrandMail = {
  brand: { id: number; slug: string; name: string };
  transport: { ready: boolean; estateFrom: string | null };
  sender: BrandSender & { sendsFrom: string | null };
  old: { key: string; label: string; value: string }[];
  week: { sent: number; waiting: number; failed: number; lastError: string | null };
};

const mask = (value: string) => (value.length <= 4 ? "••••" : `${"•".repeat(8)}${value.slice(-4)}`);

async function brandFor(guard: Guarded, slug: string, permission: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, permission, database);

  return brand;
}

async function brandValues(siteId: number, keys: readonly string[], database: Database): Promise<Map<string, string>> {
  const rows = await database
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), inArray(settings.key, [...keys])));

  return new Map(rows.map((row) => [row.key, row.value.trim()]));
}

async function putValue(siteId: number, key: string, value: string | null, database: Database): Promise<void> {
  const where = and(eq(settings.siteId, siteId), eq(settings.key, key));

  await database.delete(settings).where(where);

  if (value) {
    await database.insert(settings).values({ siteId, key, value });
  }
}

/**
 * The sender a brand's mail goes out under. Read by delivery for every mail,
 * so it is the one place the confirmation rule is applied.
 */
export async function senderFor(siteId: number, database: Database = db()): Promise<BrandSender> {
  const values = await brandValues(siteId, SENDER_KEYS, database);
  const fromAddress = values.get("mail_from_address") || null;
  const confirmedAddress = values.get("mail_from_confirmed") || null;

  return {
    fromAddress,
    confirmed: fromAddress !== null && confirmedAddress?.toLowerCase() === fromAddress.toLowerCase(),
    replyTo: values.get("mail_reply_to") || null,
  };
}

export async function brandMail(
  guard: Guarded,
  input: { site: string },
  database: Database = db(),
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<BrandMail> {
  const brand = await brandFor(guard, input.site, "setting-list", database);
  const sender = await senderFor(brand.id, database);
  const estateFrom = env.MAIL_FROM?.trim() || null;
  const oldValues = await brandValues(brand.id, OLD_CREDENTIALS.map((row) => row.key), database);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const mine = eq(mailOutbox.siteId, brand.id);

  const [[sent], [waiting], [failed], [last]] = await Promise.all([
    database.select({ n: count() }).from(mailOutbox).where(and(mine, gte(mailOutbox.sentAt, since))),
    database.select({ n: count() }).from(mailOutbox).where(and(mine, isNull(mailOutbox.sentAt), isNull(mailOutbox.failedAt))),
    database.select({ n: count() }).from(mailOutbox).where(and(mine, gte(mailOutbox.failedAt, since))),
    database
      .select({ error: mailOutbox.error })
      .from(mailOutbox)
      .where(and(mine, isNotNull(mailOutbox.error), or(isNotNull(mailOutbox.failedAt), isNull(mailOutbox.sentAt))))
      .orderBy(desc(mailOutbox.id))
      .limit(1),
  ]);

  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name },
    transport: { ready: transportFromEnv(env) !== null, estateFrom },
    sender: { ...sender, sendsFrom: sender.confirmed ? sender.fromAddress : estateFrom },
    old: OLD_CREDENTIALS.filter((row) => oldValues.get(row.key)).map((row) => ({
      key: row.key,
      label: row.label,
      value: "secret" in row ? mask(oldValues.get(row.key)!) : oldValues.get(row.key)!,
    })),
    week: { sent: sent?.n ?? 0, waiting: waiting?.n ?? 0, failed: failed?.n ?? 0, lastError: last?.error ?? null },
  };
}

function address(value: string, field: string, what: string): string | null {
  const text = value.trim();

  if (text === "") {
    return null;
  }

  if (!EMAIL.test(text) || text.length > 191) {
    throw new AccountError(`The ${what} is not an email address.`, 422, field);
  }

  return text;
}

/** Change the brand's From and reply-to. A new From is unconfirmed until tested. */
export async function saveSender(
  guard: Guarded,
  input: { site: string; fromAddress: string; replyTo: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<BrandSender> {
  const brand = await brandFor(guard, input.site, "setting-edit", database);
  const before = await senderFor(brand.id, database);
  const fromAddress = address(input.fromAddress, "fromAddress", "From address");
  const replyTo = address(input.replyTo, "replyTo", "reply-to address");

  await database.transaction(async (tx) => {
    await putValue(brand.id, "mail_from_address", fromAddress, tx as unknown as Database);
    await putValue(brand.id, "mail_reply_to", replyTo, tx as unknown as Database);

    await tx.insert(auditLog).values({
      siteId: brand.id,
      userId: guard.identity.user.id,
      action: "mail.sender",
      entity: "site",
      entityId: brand.id,
      detail: { from: [before.fromAddress, fromAddress], replyTo: [before.replyTo, replyTo] },
      ip: context.ip ?? null,
    });
  });

  return senderFor(brand.id, database);
}

/**
 * Send one mail from the brand's address, straight through the transport.
 * If the provider takes it, the address is confirmed and the brand's mail
 * goes from it from now on; if not, the provider's answer is shown and
 * nothing changes.
 */
export async function sendTest(
  guard: Guarded,
  input: { site: string; to: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
  transport: Transport | null = transportFromEnv(),
): Promise<{ from: string; to: string }> {
  const brand = await brandFor(guard, input.site, "setting-edit", database);
  const sender = await senderFor(brand.id, database);
  const to = address(input.to, "to", "test address");

  if (!to) {
    throw new AccountError("Give an address to send the test to.", 422, "to");
  }

  if (!sender.fromAddress) {
    throw new AccountError("Save a From address first; the test is sent from it.", 422, "fromAddress");
  }

  if (!transport) {
    throw new AccountError("Mail cannot leave yet: BREVO_API_KEY and MAIL_FROM are not set.", 409, "to");
  }

  try {
    await transport.send({
      to,
      subject: `${brand.name}: test mail`,
      html: `<p>This is a test from ${brand.name}, sent from ${sender.fromAddress}.</p><p>It arrived, so ${brand.name}'s mail can go from this address.</p>`,
      text: `This is a test from ${brand.name}, sent from ${sender.fromAddress}. It arrived, so ${brand.name}'s mail can go from this address.`,
      fromName: brand.name,
      fromEmail: sender.fromAddress,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    });
  } catch (error) {
    if (error instanceof SendError) {
      throw new AccountError(`The provider refused it, so ${sender.fromAddress} is not used yet. ${error.message}`, 409, "to");
    }

    throw error;
  }

  await putValue(brand.id, "mail_from_confirmed", sender.fromAddress, database);
  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "mail.sender_confirmed",
    entity: "site",
    entityId: brand.id,
    detail: { from: sender.fromAddress, to },
    ip: context.ip ?? null,
  });

  return { from: sender.fromAddress, to };
}

/** Delete the old site's SMTP login. The audit records which keys, never their values. */
export async function deleteOldCredentials(
  guard: Guarded,
  input: { site: string },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ removed: number }> {
  const brand = await brandFor(guard, input.site, "setting-delete", database);
  const keys = OLD_CREDENTIALS.map((row) => row.key);

  return database.transaction(async (tx) => {
    const removed = await tx
      .delete(settings)
      .where(and(eq(settings.siteId, brand.id), inArray(settings.key, keys)))
      .returning({ key: settings.key });

    if (removed.length) {
      await tx.insert(auditLog).values({
        siteId: brand.id,
        userId: guard.identity.user.id,
        action: "mail.old_credentials_deleted",
        entity: "site",
        entityId: brand.id,
        detail: { keys: removed.map((row) => row.key) },
        ip: context.ip ?? null,
      });
    }

    return { removed: removed.length };
  });
}
