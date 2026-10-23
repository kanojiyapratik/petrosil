/**
 * The decisions a migration has to make, separated from the reading and
 * writing so they can be tested on their own.
 *
 * Every rule here exists because the old data breaks a rule the new schema
 * enforces. They are listed in the build spec's trap sheet, and each was hit
 * for real: the methanolreport dump alone carries 95 case-duplicate email
 * addresses, 287 soft-deleted prices and 8 zero dates in a table of 1,439
 * people.
 */

export type LegacyUser = {
  id: number;
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  mobile: string | null;
  country: string | null;
  premium: number;
  user_status: string | null;
  isAdmin: number;
  expiry_date: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  password: string | null;
  email_verified_at: Date | string | null;
  deleted_at: Date | string | null;
};

export type MigratedUser = {
  legacyIds: number[];
  email: string;
  name: string;
  company: string | null;
  phone: string | null;
  country: string | null;
  status: "active" | "disabled";
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  tier: "free" | "premium" | "trial";
  expiresAt: string | null;
  wasAdmin: boolean;
};

/** MySQL's zero date, which is not a date and breaks a strict-mode insert. */
export function readDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value).trim();

  if (text === "" || text.startsWith("0000-00-00")) {
    return null;
  }

  const parsed = new Date(text.replace(" ", "T"));

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readDay(value: Date | string | null | undefined): string | null {
  const date = readDate(value);

  if (date === null) {
    return null;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * What the old `premium` column means.
 *
 * It looks like a flag and is not: the old site's own
 * `DirectoryController::listDirectory` branches on four values, which is how
 * its menu builds "Premium Users" (1), "Expired Premium Users" (2) and the
 * two trial lists (3). Reading it as a boolean put 146 lapsed and 29 trial
 * users on baseoil alone into the free pile.
 *
 * 2 becomes `premium` rather than `free` on purpose. They are not paying,
 * and the dashboard says so the moment their expiry is in the past — but the
 * fact they once paid is the entire reason anyone looks at that list.
 */
export function tierFor(premium: unknown): "free" | "premium" | "trial" {
  switch (Number(premium)) {
    case 1:
    case 2:
      return "premium";
    case 3:
      return "trial";
    default:
      return "free";
  }
}

/** A year nobody can have meant. baseoil holds one 0200 and two 2050. */
const EXPIRY_YEARS = { from: 2000, to: 2040 } as const;

/**
 * An expiry date worth believing.
 *
 * Outside that window the value is not a date somebody chose: `0200-10-15`
 * is a typo that would read as "lapsed eighteen centuries ago", and
 * `2050-12-30` is staff writing "never", which an absent date already says
 * and says better.
 */
export function readExpiry(value: Date | string | null | undefined): string | null {
  const day = readDay(value);

  if (day === null) {
    return null;
  }

  const year = Number(day.slice(0, 4));

  return year >= EXPIRY_YEARS.from && year <= EXPIRY_YEARS.to ? day : null;
}

/**
 * What one legacy row becomes. `premium` is a flag and `expiry_date` is
 * separate, so a lapsed subscriber arrives as premium-with-a-past-expiry —
 * which is exactly how the dashboard reads "expired", and keeps the fact
 * that they once paid.
 */
/**
 * @param subscriptionExpiry the date from `subscription_users`, which is
 *   where the real ones live -- `users.expiry_date` is NULL for every row in
 *   the estate, so the first cut of this migration gave nobody an expiry and
 *   every payer read as open-ended.
 */
export function readUser(
  row: LegacyUser,
  subscriptionExpiry: Date | string | null = null,
): MigratedUser {
  const name =
    (row.name ?? "").trim() ||
    [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
    row.email.split("@")[0] ||
    "Unknown";

  const created = readDate(row.created_at) ?? readDate(row.updated_at) ?? new Date("2015-01-01");

  const tier = tierFor(row.premium);

  // The subscription's date first, then the one on the user row for the rare
  // dump that has it. A free account never carries one: an expiry beside a
  // free tier is what once handed a duplicated free row an open-ended
  // premium subscription.
  let expiry = tier === "free" ? null : readExpiry(subscriptionExpiry) ?? readExpiry(row.expiry_date);

  // A lapsed member with no subscription row to date it by -- one user on
  // baseoil. Left absent it would read as premium with no end, which shows a
  // non-payer as paying; the row's own last change is the best evidence
  // available of when it was flipped, and it is reported as a fallback.
  if (expiry === null && Number(row.premium) === 2) {
    expiry = readDay(row.updated_at);
  }

  return {
    legacyIds: [row.id],
    email: row.email.trim().toLowerCase(),
    name: name.slice(0, 191),
    company: fit(row.company_name, 191),
    // A "phone number" longer than the column is not one: three of the nine
    // dumps have newsletter spam pasted into `mobile`. Truncating would
    // leave a plausible-looking wrong number, so it is dropped instead.
    phone: within(row.mobile, 64),
    country: fit(row.country, 96),
    status: (row.user_status ?? "Active").toLowerCase() === "active" ? "active" : "disabled",
    // Carried as it is: Laravel's $2y$ hashes verify unchanged, which is what
    // lets every subscriber keep the password they already have.
    passwordHash: nullable(row.password),
    emailVerifiedAt: readDate(row.email_verified_at),
    createdAt: created,
    tier,
    expiresAt: expiry,
    wasAdmin: row.isAdmin === 1,
  };
}

/**
 * Collapse duplicate email addresses.
 *
 * The Laravel table has no unique index and MySQL's collation is
 * case-insensitive, so `Rahul@x.com` and `rahul@x.com` are two rows that the
 * new unique index would reject. The survivor keeps the strongest standing
 * of the set — paying beats free, the furthest expiry wins — because
 * dropping a subscription someone paid for is the one mistake that costs
 * money. Everything else falls to the most recently created row.
 */
export function dedupeByEmail(users: MigratedUser[]): {
  kept: MigratedUser[];
  merged: number;
} {
  const byEmail = new Map<string, MigratedUser>();
  let merged = 0;

  for (const user of users) {
    const existing = byEmail.get(user.email);

    if (!existing) {
      byEmail.set(user.email, user);
      continue;
    }

    merged += 1;

    const newer = user.createdAt > existing.createdAt ? user : existing;
    const older = newer === user ? existing : user;

    const survivor: MigratedUser = {
      ...newer,
      legacyIds: [...existing.legacyIds, ...user.legacyIds].sort((a, b) => a - b),
      // Keep a password and a verification if either row had one.
      passwordHash: newer.passwordHash ?? older.passwordHash,
      emailVerifiedAt: newer.emailVerifiedAt ?? older.emailVerifiedAt,
      company: newer.company ?? older.company,
      phone: newer.phone ?? older.phone,
      country: newer.country ?? older.country,
      createdAt: newer.createdAt < older.createdAt ? newer.createdAt : older.createdAt,
      status: newer.status === "active" || older.status === "active" ? "active" : "disabled",
      ...bestSubscription(newer, older),
      wasAdmin: newer.wasAdmin || older.wasAdmin,
    };

    byEmail.set(user.email, survivor);
  }

  return { kept: [...byEmail.values()], merged };
}

/**
 * The stronger of two standings.
 *
 * The expiry only means anything alongside its own tier. A FREE row has no
 * expiry either, and reading that null as "no end date" would have handed a
 * duplicate free account an open-ended premium subscription — which is what
 * the first version of this did, and what the test now pins.
 */
function bestSubscription(
  a: MigratedUser,
  b: MigratedUser,
): Pick<MigratedUser, "tier" | "expiresAt"> {
  const rank = { premium: 2, trial: 1, free: 0 } as const;

  if (rank[a.tier] > rank[b.tier]) {
    return { tier: a.tier, expiresAt: a.expiresAt };
  }

  if (rank[b.tier] > rank[a.tier]) {
    return { tier: b.tier, expiresAt: b.expiresAt };
  }

  // Same tier: the longer-lasting one, where no expiry at all is longest.
  if (a.tier === "free") {
    return { tier: "free", expiresAt: null };
  }

  if (a.expiresAt === null || b.expiresAt === null) {
    return { tier: a.tier, expiresAt: null };
  }

  return { tier: a.tier, expiresAt: a.expiresAt > b.expiresAt ? a.expiresAt : b.expiresAt };
}

export type LegacyPrice = {
  id: number;
  location_id: number;
  pricedate: Date | string | null;
  price: number | string | null;
  currency_id: number | null;
  deleted_at: Date | string | null;
};

/**
 * One price per location and date.
 *
 * `globalprices` has no unique constraint and thousands of soft-deleted
 * duplicates. The live rows alone can still collide, so the newest id wins —
 * the same "current price" rule the differ applies — and the deleted ones
 * are left behind rather than carried as history nobody can interpret.
 */
/**
 * What a price may be. The ceiling is the column's, the floor is arithmetic:
 * baseoil carries a 2018 row reading 8.06e24 and another at -1, both plainly
 * typos. Neither is clamped or quietly dropped — they are set aside and
 * listed, because inventing a number for a price is the one thing this
 * pipeline must never do.
 */
export const MAX_PRICE = 9_999_999_999;

export function dedupePrices(rows: LegacyPrice[]): {
  kept: LegacyPrice[];
  softDeleted: number;
  collisions: number;
  undated: number;
  /** Rows carrying no price at all — a gap in the sheet, not a price. */
  priceless: number;
  outOfRange: LegacyPrice[];
} {
  const live = rows.filter((row) => readDate(row.deleted_at) === null);
  const softDeleted = rows.length - live.length;

  // Newest first, so the first row seen for a cell is the one to keep.
  const ordered = [...live].sort((a, b) => b.id - a.id);
  const seen = new Map<string, LegacyPrice>();
  const outOfRange: LegacyPrice[] = [];
  let collisions = 0;
  let undated = 0;
  let priceless = 0;

  for (const row of ordered) {
    const day = readDay(row.pricedate);

    // Two different things, counted separately: baseoil has 11,105 rows
    // with no price (a gap someone never filled) and not one bad date.
    if (row.price === null) {
      priceless += 1;
      continue;
    }

    if (day === null) {
      undated += 1;
      continue;
    }

    const value = Number(row.price);

    if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
      outOfRange.push(row);
      continue;
    }

    const key = `${row.location_id}|${day}`;

    if (seen.has(key)) {
      collisions += 1;
      continue;
    }

    seen.set(key, row);
  }

  return { kept: [...seen.values()], softDeleted, collisions, undated, priceless, outOfRange };
}

function nullable(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();

  return text === "" ? null : text;
}

/** Trimmed to what the column holds. A clipped company name is still useful. */
function fit(value: string | null | undefined, max: number): string | null {
  const text = nullable(value);

  return text === null ? null : text.slice(0, max);
}

/** Kept only if it fits. For fields where a clipped value would mislead. */
function within(value: string | null | undefined, max: number): string | null {
  const text = nullable(value);

  return text === null || text.length > max ? null : text;
}

/**
 * The column list for a SELECT against a dump that may predate a column.
 *
 * bitumart and waxreport were built before `locations.show_on_dashboard`
 * existed, and asking for it stops the migration dead. Naming it as `null`
 * keeps the reading code identical for all nine brands.
 */
export function columnList(wanted: string[], available: string[]): string {
  const has = new Set(available);

  return wanted.map((name) => (has.has(name) ? name : `null as ${name}`)).join(", ");
}
