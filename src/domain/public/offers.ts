/**
 * Offers on the brand sites, as a reader sees them.
 *
 * Which of an offer's details a reader gets follows the brand's field rules
 * (`form_fields`, form "offer"): a paying reader the "paying" set, everyone
 * else the "free" set, and a switched-off field nobody. A hidden detail is
 * absent from the reply, not merely left off a screen.
 *
 * The old offer page wired the rules to the wrong fields — the contact
 * person was shown by the "value" rule and the phone by the "person" rule —
 * so here each rule governs its own field. A brand with no rule for a field
 * falls back to the default below: who and how to reach them is for paying
 * readers, what is on offer and where is for everyone.
 */

import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { formFields, offers, sites } from "@/db/schema";
import type { Entitlement } from "./paywall";

/** The rules' keys, and whether each is shown when a brand has no rule for it: [free, paying]. */
const DEFAULTS: Record<string, [boolean, boolean]> = {
  company_name: [true, true],
  country: [true, true],
  city: [true, true],
  description: [true, true],
  value: [false, true],
  person: [false, true],
  email: [false, true],
  phone: [false, true],
  contact: [false, true],
};

type Row = typeof offers.$inferSelect;

export type OfferView = {
  id: number;
  subject: string;
  offer_type: string;
  keywords: string | null;
  posted_on: string;
  image_url: string | null;
  company_name: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  description: string | null;
  offer_value: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /** Whether this reader may message the poster through the site. */
  can_contact: boolean;
};

/** Which fields this reader sees on this brand. */
export async function visibleOfferFields(siteId: number, entitled: boolean, database: Database = db()): Promise<Set<string>> {
  const rows = await database
    .select()
    .from(formFields)
    .where(and(eq(formFields.siteId, siteId), eq(formFields.form, "offer")));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const shown = new Set<string>();

  for (const [key, [free, paying]] of Object.entries(DEFAULTS)) {
    const rule = byKey.get(key);
    const visible = rule ? rule.enabled && (entitled ? rule.showPremium : rule.showFree) : entitled ? paying : free;

    if (visible) {
      shown.add(key);
    }
  }

  return shown;
}

function view(row: Row, shown: Set<string>, brand: string): OfferView {
  const when = (key: string, value: string | null) => (shown.has(key) ? value : null);

  return {
    id: row.id,
    subject: row.subject,
    offer_type: row.offerType,
    keywords: row.keywords,
    posted_on: (row.authoredOn ?? row.createdAt.toISOString().slice(0, 10)),
    // Offer pictures sit in a public folder: a picture on a public page.
    image_url: row.image ? `/api/public/${brand}/files/offers/images/${encodeURIComponent(row.image)}` : null,
    company_name: when("company_name", row.companyName),
    country: when("country", row.country),
    state: when("city", row.state),
    city: when("city", row.city),
    description: when("description", row.description),
    offer_value: when("value", row.offerValue),
    contact_person: when("person", row.contactPerson),
    contact_email: when("email", row.contactEmail),
    contact_phone: when("phone", row.contactPhone),
    can_contact: shown.has("contact"),
  };
}

const live = (siteId: number) =>
  and(eq(offers.siteId, siteId), eq(offers.status, "published"), isNull(offers.deletedAt));

async function slugOf(siteId: number, database: Database) {
  const [brand] = await database.select({ slug: sites.slug }).from(sites).where(eq(sites.id, siteId)).limit(1);

  return brand?.slug ?? "";
}

export async function publishedOffers(
  siteId: number,
  entitlement: Entitlement,
  options: { type?: string; search?: string; limit?: number; offset?: number },
  database: Database = db(),
): Promise<{ offers: OfferView[]; total: number }> {
  const where = and(
    live(siteId),
    options.type === "buy" || options.type === "sell" ? eq(offers.offerType, options.type) : undefined,
    options.search
      ? or(ilike(offers.subject, `%${options.search}%`), ilike(offers.keywords, `%${options.search}%`))
      : undefined,
  );

  const [counted] = await database.select({ n: count() }).from(offers).where(where);
  const rows = await database
    .select()
    .from(offers)
    .where(where)
    .orderBy(desc(offers.createdAt), desc(offers.id))
    .limit(Math.min(100, Math.max(1, options.limit ?? 20)))
    .offset(Math.max(0, options.offset ?? 0));
  const [shown, brand] = await Promise.all([visibleOfferFields(siteId, entitlement.entitled, database), slugOf(siteId, database)]);

  return { offers: rows.map((row) => view(row, shown, brand)), total: Number(counted?.n ?? 0) };
}

/** One live offer, counted as a view. Null for a suspended, withdrawn or other brand's offer. */
export async function publishedOffer(
  siteId: number,
  id: number,
  entitlement: Entitlement,
  database: Database = db(),
): Promise<OfferView | null> {
  const [row] = await database
    .select()
    .from(offers)
    .where(and(live(siteId), eq(offers.id, id)))
    .limit(1);

  if (!row) {
    return null;
  }

  try {
    await database
      .update(offers)
      .set({ clicks: sql`${offers.clicks} + 1` })
      .where(eq(offers.id, row.id));
  } catch (error) {
    console.error("could not count an offer view", { id: row.id, error });
  }

  const [shown, brand] = await Promise.all([visibleOfferFields(siteId, entitlement.entitled, database), slugOf(siteId, database)]);

  return view(row, shown, brand);
}
