/**
 * The company directory on the brand sites: the brand's own members, by
 * company.
 *
 * Who is listed is the old rule: a reader of this brand (not the team) whose
 * account is active and whose address is confirmed. One thing is added: a
 * member with no company name is left out. The old list printed them as an
 * empty link, and a directory of companies has nothing to say about them.
 *
 * Which details a reader gets follows the brand's field rules (`form_fields`,
 * form "directory"), as offers do: a paying reader the "paying" set, everyone
 * else the "free" set, a switched-off field nobody, and a hidden detail is
 * absent from the reply. The old site applied the same rules in its
 * templates. Searching follows them too: a reader who may not see names
 * cannot find a member by name, or a match would give the name away.
 *
 * The old profile carried a phone and a mobile; the migration kept whichever
 * was filled in one `phone`. It cannot be told which it was, so it is shown
 * only where both rules allow. The old "state" and free-text "profile" were
 * not carried, so their rules have nothing to show.
 */

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";

import { db, type Database } from "@/db";
import { formFields, memberships, users } from "@/db/schema";
import type { Entitlement } from "./paywall";

/** The rules' keys, and whether each is shown when a brand has no rule for it: [free, paying]. */
const DEFAULTS: Record<string, [boolean, boolean]> = {
  company_name: [true, true],
  person: [true, true],
  designation: [true, true],
  country: [true, true],
  city: [true, true],
  website: [true, true],
  address: [false, true],
  email: [false, true],
  phone: [false, true],
  mobile: [false, true],
  user_contact: [false, true],
};

const PAID_TIERS = ["premium", "trial"];

export type DirectoryEntry = {
  id: number;
  company: string | null;
  /** A paying member of this brand: the old "Premium member" badge. */
  premium_member: boolean;
  person: string | null;
  designation: string | null;
  country: string | null;
  city: string | null;
  website: string | null;
  address: string | null;
  postcode: string | null;
  email: string | null;
  phone: string | null;
  /** Whether this reader may write to the company through the site. */
  can_contact: boolean;
};

/** Which fields this reader sees on this brand. */
export async function visibleDirectoryFields(siteId: number, entitled: boolean, database: Database = db()): Promise<Set<string>> {
  const rows = await database
    .select()
    .from(formFields)
    .where(and(eq(formFields.siteId, siteId), eq(formFields.form, "directory")));
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

/** The members a brand's directory lists. Also what a company enquiry may be sent to. */
export function listedOn(siteId: number): SQL {
  return and(
    eq(memberships.siteId, siteId),
    eq(memberships.role, "subscriber"),
    eq(users.status, "active"),
    isNotNull(users.emailVerifiedAt),
    ne(sql`trim(coalesce(${users.company}, ''))`, ""),
  )!;
}

const COLUMNS = {
  id: users.id,
  company: users.company,
  name: users.name,
  designation: users.designation,
  country: users.country,
  city: users.city,
  website: users.website,
  address: users.address,
  postcode: users.postcode,
  email: users.email,
  phone: users.phone,
  tier: memberships.tier,
};

type Row = { [K in keyof typeof COLUMNS]: (typeof COLUMNS)[K]["_"]["data"] | null };

function entry(row: Row, shown: Set<string>): DirectoryEntry {
  const when = (key: string, value: string | null) => (shown.has(key) && value?.trim() ? value.trim() : null);

  return {
    id: row.id!,
    company: when("company_name", row.company),
    premium_member: PAID_TIERS.includes(row.tier ?? ""),
    person: when("person", row.name),
    designation: when("designation", row.designation),
    country: when("country", row.country),
    city: when("city", row.city),
    website: when("website", row.website),
    address: when("address", row.address),
    postcode: when("address", row.postcode),
    email: when("email", row.email),
    phone: shown.has("mobile") ? when("phone", row.phone) : null,
    can_contact: shown.has("user_contact"),
  };
}

export type DirectoryOptions = {
  search?: string;
  /** "premium" for paying members, "free" for the rest — the old tabs. */
  tier?: string;
  country?: string;
  /** Companies starting with this letter — the old A–Z bar. */
  letter?: string;
  limit?: number;
  offset?: number;
};

export async function directory(
  siteId: number,
  entitlement: Entitlement,
  options: DirectoryOptions,
  database: Database = db(),
): Promise<{ companies: DirectoryEntry[]; total: number; countries: { country: string; companies: number }[] }> {
  const shown = await visibleDirectoryFields(siteId, entitlement.entitled, database);
  const words = options.search ? `%${options.search}%` : null;
  const letter = options.letter && /^[a-z0-9]$/i.test(options.letter) ? options.letter : null;
  const country = shown.has("country") && options.country?.trim() ? options.country.trim() : null;

  const where = and(
    listedOn(siteId),
    words
      ? or(
          shown.has("company_name") ? ilike(users.company, words) : undefined,
          shown.has("person") ? ilike(users.name, words) : undefined,
          shown.has("designation") ? ilike(users.designation, words) : undefined,
          // Nothing the reader may search by: nothing matches.
          sql`false`,
        )
      : undefined,
    options.tier === "premium" ? inArray(memberships.tier, PAID_TIERS) : undefined,
    options.tier === "free" ? sql`${memberships.tier} not in ('premium', 'trial')` : undefined,
    country ? sql`lower(trim(${users.country})) = ${country.toLowerCase()}` : undefined,
    letter && shown.has("company_name") ? ilike(sql`trim(${users.company})`, `${letter}%`) : undefined,
  );

  const from = () => database.select({ n: count() }).from(users).innerJoin(memberships, eq(memberships.userId, users.id));

  const [[counted], rows, countries] = await Promise.all([
    from().where(where),
    database
      .select(COLUMNS)
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(where)
      // Newest first, as the old list was.
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(Math.min(100, Math.max(1, options.limit ?? 20)))
      .offset(Math.max(0, options.offset ?? 0)),
    shown.has("country")
      ? database
          .select({ country: sql<string>`trim(${users.country})`, companies: count() })
          .from(users)
          .innerJoin(memberships, eq(memberships.userId, users.id))
          .where(and(listedOn(siteId), ne(sql`trim(coalesce(${users.country}, ''))`, "")))
          .groupBy(sql`trim(${users.country})`)
          .orderBy(asc(sql`trim(${users.country})`))
      : Promise.resolve([]),
  ]);

  return {
    companies: rows.map((row) => entry(row, shown)),
    total: Number(counted?.n ?? 0),
    countries: countries.map((row) => ({ country: row.country, companies: Number(row.companies) })),
  };
}

/** One listed company. Null for anyone this brand's directory does not list. */
export async function directoryEntry(
  siteId: number,
  id: number,
  entitlement: Entitlement,
  database: Database = db(),
): Promise<DirectoryEntry | null> {
  const [row] = await database
    .select(COLUMNS)
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(and(listedOn(siteId), eq(users.id, id)))
    .limit(1);

  if (!row) {
    return null;
  }

  return entry(row, await visibleDirectoryFields(siteId, entitlement.entitled, database));
}
