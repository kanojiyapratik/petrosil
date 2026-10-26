/**
 * Reading the old sites' content columns.
 *
 * Two columns do most of the damage. `publish_options` is a single varchar
 * carrying two separate ideas — whether a thing is published and whether it
 * is behind the paywall — spelled four ways across the nine dumps. And
 * `path` is the slug, except where it is null, blank, or identical to
 * another row's, which the old schema had no index to prevent.
 *
 * Nothing here invents a published state: anything unrecognised becomes a
 * draft, because quietly publishing content nobody decided to publish is the
 * one mistake a migration must not make.
 */

import { readDate } from "./transform";

export type ReadStatus = {
  status: "published" | "draft" | "withdrawn";
  /** Published, but only to subscribers. */
  premium: boolean;
};

export function readStatus(value: string | null | undefined): ReadStatus {
  switch ((value ?? "").trim().toLowerCase()) {
    case "published":
      return { status: "published", premium: false };
    case "premium":
      return { status: "published", premium: true };
    case "suspend":
    case "suspended":
    case "unpublished":
      return { status: "withdrawn", premium: false };
    default:
      return { status: "draft", premium: false };
  }
}

/** The column is 191, so neither a path nor a title may exceed it. */
const MAX = 191;

/**
 * A slug from the old `path`, or from the title when there was none.
 *
 * Returns "" rather than something invented when there is nothing to work
 * with; `uniqueSlug` is what decides what to do about that.
 */
export function slugify(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/g, "");
}

/**
 * The same slug, made unique within one brand.
 *
 * A collision keeps both rows and numbers the later one rather than dropping
 * it: baseoil has 20,327 published articles and a handful of them share a
 * path, and losing an article to a duplicate URL is worse than an ugly URL.
 */
export function uniqueSlug(base: string, legacyId: number, seen: Set<string>): string {
  const root = slugify(base) || `item-${legacyId}`;

  if (!seen.has(root)) {
    seen.add(root);

    return root;
  }

  for (let at = 2; ; at += 1) {
    const candidate = `${root.slice(0, MAX - 6)}-${at}`;

    if (!seen.has(candidate)) {
      seen.add(candidate);

      return candidate;
    }
  }
}

/** As many characters of a locked article as everybody gets to read. */
const EXCERPT = 300;

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  deg: "°",
};

/** HTML to the words inside it. Good enough for an excerpt, not a sanitiser. */
function plain(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }

      if (name.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      }

      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The hook a locked article shows to everyone.
 *
 * `meta_description` is the old field for it and most rows leave it empty,
 * so the opening of the body stands in. Without this an article behind the
 * paywall shows a headline and a blank space, which sells nothing — and
 * 119,000 of them came across.
 *
 * Cut at a word, and marked as cut, so it never reads like a sentence that
 * stops for no reason.
 */
export function excerptFrom(
  metaDescription: string | null | undefined,
  body: string | null | undefined,
): string | null {
  const given = (metaDescription ?? "").trim();

  if (given !== "") {
    return plain(given).slice(0, 1000) || null;
  }

  const words = plain(body ?? "");

  if (words === "") {
    return null;
  }

  if (words.length <= EXCERPT) {
    return words;
  }

  const cut = words.slice(0, EXCERPT);
  const lastSpace = cut.lastIndexOf(" ");

  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * What an old `subscription_users.payment_status` meant.
 *
 * Three spellings across the estate — "Paid", "success", and null for 255 of
 * baseoil's 635 rows. A null is a payment nobody recorded, which is not the
 * same as a payment that happened, so it arrives pending.
 */
export function readPaymentStatus(
  value: string | null | undefined,
): "paid" | "pending" | "failed" | "cancelled" {
  switch ((value ?? "").trim().toLowerCase()) {
    case "paid":
    case "success":
    case "successful":
    case "completed":
      return "paid";
    case "failed":
    case "failure":
    case "declined":
      return "failed";
    case "cancelled":
    case "canceled":
    case "refunded":
      return "cancelled";
    default:
      return "pending";
  }
}

/**
 * The terms a plan is sold for.
 *
 * The old `subscriptions` table priced one, two and three years as `cost`,
 * `cost2` and `cost3` — three columns rather than three rows, which is why
 * the old admin reached them through `getPrice/{plan}/{year}`, one page per
 * combination. A zero or a null is a term that was never sold, not a free
 * one, so it is left out.
 */
export function termsFrom(
  one: number | string | null | undefined,
  two: number | string | null | undefined,
  three: number | string | null | undefined,
): { years: number; amount: string }[] {
  const terms: { years: number; amount: string }[] = [];

  for (const [years, raw] of [
    [1, one],
    [2, two],
    [3, three],
  ] as const) {
    const amount = Number(raw ?? 0);

    if (Number.isFinite(amount) && amount > 0) {
      terms.push({ years, amount: amount.toFixed(2) });
    }
  }

  // Nothing is sold for two years that is not sold for one.
  return terms[0]?.years === 1 ? terms : [];
}

export type CouponTerms = {
  percentOff: number | null;
  amountOff: string | number | null;
  enabled: boolean;
};

export type CouponDecision =
  | { action: "create"; siteId: number }
  | { action: "broaden" }
  | { action: "keep" }
  | { action: "conflict" };

/**
 * Which brand a carried coupon belongs to.
 *
 * Every one of the nine sites prints the same `EARLY10` at 10% — nine rows
 * saying one thing, because each site had its own table. Here `code` is
 * unique across the estate and a null brand means "works everywhere", so the
 * second brand to arrive with identical terms broadens the first brand's row
 * rather than colliding with it.
 *
 * Identical terms is the whole condition. Two brands using the same word for
 * different discounts is not one coupon, and merging them would quietly
 * change what one brand's customers get — so that is reported rather than
 * guessed at.
 */
export function couponAction(
  existing: (CouponTerms & { siteId: number | null }) | null,
  incoming: CouponTerms,
  siteId: number,
): CouponDecision {
  if (!existing) {
    return { action: "create", siteId };
  }

  const same =
    existing.percentOff === incoming.percentOff &&
    Number(existing.amountOff ?? 0) === Number(incoming.amountOff ?? 0) &&
    existing.enabled === incoming.enabled;

  if (!same) {
    return { action: "conflict" };
  }

  // Already everywhere, or already this brand's own: nothing to change.
  if (existing.siteId === null || existing.siteId === siteId) {
    return { action: "keep" };
  }

  return { action: "broaden" };
}

/** The symbols the old estate writes instead of codes. */
const SYMBOLS: Record<string, string> = {
  "₹": "INR",
  "Rs": "INR",
  "Rs.": "INR",
  "$": "USD",
  "US$": "USD",
  "€": "EUR",
  "£": "GBP",
};

/**
 * Which currency an old order was in.
 *
 * `subscription_users.currency_code` is free text carrying three different
 * things: the symbol (₹ on 271 baseoil rows, $ on 128), the ISO code (INR on
 * 8, USD on 3) and nothing (225). Upper-casing it put `₹` and `$` into a
 * column meant for ISO codes, and the admin then showed four currencies for
 * two — with a Transactions total that added rupees to dollars.
 *
 * `currency_id` points at the old `currencies` master and is right wherever
 * it is set, so it is tried first. The fallback is the plan's own currency,
 * because the plan is what priced the sale.
 */
export function readCurrency(
  currencyId: number | null | undefined,
  given: string | null | undefined,
  master: Map<number, string>,
  fallback: string,
): string {
  const byId = currencyId === null || currencyId === undefined ? undefined : master.get(Number(currencyId));

  if (byId) {
    return byId;
  }

  const text = String(given ?? "").trim();

  if (text === "") {
    return fallback;
  }

  // An ISO code the master knows, however it was typed.
  const code = text.toUpperCase();

  if ([...master.values()].includes(code)) {
    return code;
  }

  return SYMBOLS[text] ?? fallback;
}

/** The fields that make a profile row worth keeping, in no particular order. */
export type ProfileRow = {
  countryId?: number | null;
  companyName?: string | null;
  designation?: string | null;
  address1?: string | null;
  cityId?: number | null;
  phone?: string | null;
  website?: string | null;
  updatedAt?: Date | string | null;
};

/** How much this row actually says. */
function filled(row: ProfileRow): number {
  const values = [
    row.countryId,
    row.companyName,
    row.designation,
    row.address1,
    row.cityId,
    row.phone,
    row.website,
  ];

  return values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
    .length;
}

/**
 * Which of a person's profile rows is the one to carry.
 *
 * `profiles` holds 18,421 rows for 17,297 users on baseoil: about 1,124
 * people re-registered and left a second, usually emptier, row. This is
 * where the customer's country lives — the field the rupee/dollar split
 * turns on — so the choice decides whether a paying customer in India is
 * shown the right price list.
 *
 * The fullest row wins, not the newest: a later empty re-registration must
 * not erase an address and a country. A genuine tie goes to whichever was
 * touched last.
 */
export function bestProfile<T extends ProfileRow>(rows: T[]): T | null {
  if (rows.length === 0) {
    return null;
  }

  return rows.reduce((best, row) => {
    const byFilled = filled(row) - filled(best);

    if (byFilled !== 0) {
      return byFilled > 0 ? row : best;
    }

    const rowAt = readDate(row.updatedAt)?.getTime() ?? 0;
    const bestAt = readDate(best.updatedAt)?.getTime() ?? 0;

    return rowAt > bestAt ? row : best;
  });
}

/**
 * Which system mail an old `mails` row is. By id, because that is how the old
 * code chose them — `MailTemplate::findOrFail(5)` — and the `mailkey` column
 * is blank on several brands' rows. Ids 2/3 and 10/11 are regional pairs, tied
 * to countries through `country_mail`: the Asia edition and the rest-of-world
 * one.
 */
const SYSTEM_MAILS: Record<number, { key: string; variant: string }> = {
  1: { key: "welcome", variant: "default" },
  2: { key: "subscription-details", variant: "asia" },
  3: { key: "subscription-details", variant: "default" },
  4: { key: "staff-alert", variant: "default" },
  5: { key: "trial-expiring", variant: "default" },
  6: { key: "trial-expired", variant: "default" },
  7: { key: "trial-exhausted", variant: "default" },
  8: { key: "subscription-expiring", variant: "default" },
  9: { key: "subscription-expired", variant: "default" },
  10: { key: "sample-reports", variant: "default" },
  11: { key: "sample-reports", variant: "asia" },
  12: { key: "send-report", variant: "default" },
};

export function systemMailFor(legacyId: number): { key: string; variant: string } | null {
  return SYSTEM_MAILS[legacyId] ?? null;
}
