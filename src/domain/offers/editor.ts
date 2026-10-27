/**
 * Writing an offer from the admin.
 *
 * Staff type many offers in for somebody who phoned, so the contact details
 * live on the row. An offer can also be tied to the member it is for, by
 * their email, which is what lets the brand site list a member's own offers.
 *
 * The old admin suspended an offer by setting `publish_options` to
 * "Suspend" and deleted with a hard delete. Here suspending is a status and
 * deleting is withdrawing: enquiries point at offers, and an enquiry about an
 * offer that no longer exists is one nobody can follow up.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, offers, sites, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { attachable, storedFileId } from "@/domain/files/attach";

export const OFFER_STATUSES = ["published", "draft", "suspended"] as const;

export const IMAGE_FOLDER = "offers/images";
export const FILE_FOLDER = "offers/files";

type Row = typeof offers.$inferSelect;

/** Text fields an editor may set, with their column and length. */
const TEXT = {
  keywords: ["keywords", 255],
  description: ["description", 20_000],
  contact_person: ["contactPerson", 191],
  contact_phone: ["contactPhone", 64],
  company_name: ["companyName", 191],
  city: ["city", 96],
  state: ["state", 96],
  country: ["country", 96],
  offer_value: ["offerValue", 64],
} as const;

function optional(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";

  return text === "" ? null : text.slice(0, max);
}

export function subject(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");

  if (text === "") {
    throw new AccountError("Give the offer a subject.", 422, "subject");
  }

  return text.slice(0, 255);
}

export function offerType(value: unknown): "buy" | "sell" {
  if (value !== "buy" && value !== "sell") {
    throw new AccountError("Say whether they are buying or selling.", 422, "offer_type");
  }

  return value;
}

function status(value: unknown): string {
  if (!(OFFER_STATUSES as readonly string[]).includes(String(value))) {
    throw new AccountError("Choose published, draft or suspended.", 422, "status");
  }

  return String(value);
}

export function contactEmail(value: unknown): string | null {
  const text = optional(value, 191);

  if (text !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new AccountError("That contact email is not an address.", 422, "contact_email");
  }

  return text;
}

/** The member an offer is for, by email. Blank: nobody. */
async function poster(value: unknown, database: Database): Promise<number | null> {
  const email = optional(value, 191)?.toLowerCase() ?? null;

  if (email === null) {
    return null;
  }

  const [found] = await database
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (!found) {
    throw new AccountError("Nobody has an account with that email.", 422, "poster_email");
  }

  return found.id;
}

const attach = (siteId: number, field: "image" | "file", value: unknown, database: Database) =>
  field === "image"
    ? attachable(siteId, IMAGE_FOLDER, "image", value, "picture", database)
    : attachable(siteId, FILE_FOLDER, "file", value, "attachment", database);

export type OfferSaved = {
  id: number;
  subject: string;
  status: string;
  offer_value: string | null;
  image: string | null;
  file: string | null;
};

const saved = (row: Row): OfferSaved => ({
  id: row.id,
  subject: row.subject,
  status: row.status,
  offer_value: row.offerValue,
  image: row.image,
  file: row.file,
});

/** The text columns the body names; undefined ones are left alone. */
export function textChanges(body: Record<string, unknown>): Partial<typeof offers.$inferInsert> {
  const changes: Record<string, string | null> = {};

  for (const [field, [column, max]] of Object.entries(TEXT)) {
    if (body[field] !== undefined) {
      changes[column] = optional(body[field], max);
    }
  }

  return changes as Partial<typeof offers.$inferInsert>;
}

export async function createOffer(
  guard: Guarded,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<OfferSaved> {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, String(body.site ?? ""))).limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "offer-create", database);

  const [row] = await database
    .insert(offers)
    .values({
      siteId: brand.id,
      subject: subject(body.subject),
      offerType: offerType(body.offer_type),
      status: body.status === undefined ? "draft" : status(body.status),
      contactEmail: contactEmail(body.contact_email),
      userId: await poster(body.poster_email, database),
      image: (await attach(brand.id, "image", body.image, database)) ?? null,
      file: (await attach(brand.id, "file", body.file, database)) ?? null,
      authoredOn: sql`current_date`,
      ...textChanges(body),
    })
    .returning();

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "offer.create",
    entity: "offer",
    entityId: row!.id,
    detail: { subject: row!.subject, status: row!.status, for: row!.userId },
    ip: context.ip ?? null,
  });

  return saved(row!);
}

async function editable(guard: Guarded, id: number, database: Database): Promise<Row | null> {
  const [found] = await database
    .select()
    .from(offers)
    .where(and(eq(offers.id, id), isNull(offers.deletedAt)))
    .limit(1);

  // Another brand's offer answers the same as no offer.
  return found && (guard.isSuperadmin || guard.siteIds.includes(found.siteId)) ? found : null;
}

export async function updateOffer(
  guard: Guarded,
  id: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<OfferSaved | null> {
  const found = await editable(guard, id, database);

  if (!found) {
    return null;
  }

  await requirePermission(guard, found.siteId, "offer-edit", database);

  const changes: Partial<typeof offers.$inferInsert> = textChanges(body);

  if (body.subject !== undefined) changes.subject = subject(body.subject);
  if (body.offer_type !== undefined) changes.offerType = offerType(body.offer_type);
  if (body.status !== undefined) changes.status = status(body.status);
  if (body.contact_email !== undefined) changes.contactEmail = contactEmail(body.contact_email);
  if (body.poster_email !== undefined) changes.userId = await poster(body.poster_email, database);
  if (body.image !== undefined) changes.image = await attach(found.siteId, "image", body.image, database);
  if (body.file !== undefined) changes.file = await attach(found.siteId, "file", body.file, database);

  const [after] = await database
    .update(offers)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(offers.id, id))
    .returning();

  const statusChanged = changes.status !== undefined && changes.status !== found.status;

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: statusChanged ? "offer.status" : "offer.update",
    entity: "offer",
    entityId: id,
    detail: {
      fields: Object.keys(changes).filter((key) => changes[key as keyof typeof changes] !== found[key as keyof Row]),
      ...(statusChanged ? { was: found.status, now: after!.status } : {}),
    },
    ip: context.ip ?? null,
  });

  return saved(after!);
}

export async function withdrawOffer(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const found = await editable(guard, id, database);

  if (!found) {
    return false;
  }

  await requirePermission(guard, found.siteId, "offer-delete", database);

  await database.update(offers).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(offers.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "offer.withdraw",
    entity: "offer",
    entityId: id,
    detail: { subject: found.subject },
    ip: context.ip ?? null,
  });

  return true;
}

/** One offer as its editor needs it, scoped like every dashboard read. */
export async function offerForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select({ offer: offers, slug: sites.slug, name: sites.name, posterEmail: users.email, posterName: users.name })
    .from(offers)
    .innerJoin(sites, eq(sites.id, offers.siteId))
    .leftJoin(users, eq(users.id, offers.userId))
    .where(and(eq(offers.id, id), isNull(offers.deletedAt)))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.offer.siteId))) {
    return null;
  }

  const { offer } = row;

  const [imageId, fileId] = await Promise.all([
    offer.image ? storedFileId(offer.siteId, IMAGE_FOLDER, offer.image, database) : null,
    offer.file ? storedFileId(offer.siteId, FILE_FOLDER, offer.file, database) : null,
  ]);

  return {
    id: offer.id,
    site: row.slug,
    site_name: row.name,
    subject: offer.subject,
    offer_type: offer.offerType,
    status: offer.status,
    keywords: offer.keywords,
    description: offer.description,
    contact_person: offer.contactPerson,
    contact_email: offer.contactEmail,
    contact_phone: offer.contactPhone,
    company_name: offer.companyName,
    city: offer.city,
    state: offer.state,
    country: offer.country,
    offer_value: offer.offerValue,
    image: offer.image,
    image_id: imageId,
    file: offer.file,
    file_id: fileId,
    poster_email: row.posterEmail,
    poster_name: row.posterName,
    clicks: offer.clicks,
    created_at: offer.createdAt.toISOString(),
    updated_at: offer.updatedAt.toISOString(),
  };
}

export type OfferForEdit = NonNullable<Awaited<ReturnType<typeof offerForEdit>>>;
