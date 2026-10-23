/**
 * Reading the old sites' content columns.
 *
 * `publish_options` is one varchar carrying two separate ideas — is it
 * published, and is it behind the paywall — and the nine dumps spell it four
 * ways between them ("Published", "Premium", "Draft", "Suspend"). `path` is
 * the slug, except where it is null, blank, or the same as another row's.
 */
import { describe, expect, it } from "vitest";

import {
  bestProfile,
  couponAction,
  readCurrency,
  excerptFrom,
  readPaymentStatus,
  readStatus,
  slugify,
  termsFrom,
  uniqueSlug,
} from "@/domain/migrate/content";

describe("reading publish_options", () => {
  it("separates published from behind-the-paywall", () => {
    expect(readStatus("Published")).toEqual({ status: "published", premium: false });
    expect(readStatus("Premium")).toEqual({ status: "published", premium: true });
  });

  it("treats a suspended row as withdrawn rather than deleted", () => {
    expect(readStatus("Suspend")).toEqual({ status: "withdrawn", premium: false });
  });

  it("is case- and space-insensitive, as the dumps are", () => {
    expect(readStatus("  published ")).toEqual({ status: "published", premium: false });
    expect(readStatus("PREMIUM")).toEqual({ status: "published", premium: true });
  });

  it("treats anything it does not recognise as a draft, never as published", () => {
    expect(readStatus(null)).toEqual({ status: "draft", premium: false });
    expect(readStatus("")).toEqual({ status: "draft", premium: false });
    expect(readStatus("Whatever")).toEqual({ status: "draft", premium: false });
  });
});

describe("making a slug", () => {
  it("keeps the old path, which is what the live URLs use", () => {
    expect(slugify("nigeria-kaduna-refinery")).toBe("nigeria-kaduna-refinery");
  });

  it("builds one from a title when there is no path", () => {
    expect(slugify("Korean Origin Base Oil prices slashed!")).toBe(
      "korean-origin-base-oil-prices-slashed",
    );
  });

  it("gives up gracefully rather than returning an empty slug", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("does not exceed what the column holds", () => {
    expect(slugify("a".repeat(400))).toHaveLength(191);
  });
});

describe("keeping slugs unique within a brand", () => {
  it("leaves the first one alone and numbers the rest", () => {
    const seen = new Set<string>();

    expect(uniqueSlug("prices", 1, seen)).toBe("prices");
    expect(uniqueSlug("prices", 2, seen)).toBe("prices-2");
    expect(uniqueSlug("prices", 3, seen)).toBe("prices-3");
  });

  it("falls back to the legacy id when there is nothing to slug", () => {
    expect(uniqueSlug("", 4071, new Set())).toBe("item-4071");
  });
});

/**
 * The excerpt is the hook a locked article shows to everyone, so an article
 * with no excerpt is an article with nothing to sell. `meta_description` is
 * the old field for it and most rows leave it empty.
 */
describe("the excerpt a locked article shows", () => {
  it("prefers the old meta description when there is one", () => {
    expect(excerptFrom("Prices eased in Asia.", "<p>Long body</p>")).toBe("Prices eased in Asia.");
  });

  it("falls back to the opening of the body, with the markup taken out", () => {
    const body = "<p>Base oil prices <strong>eased</strong> in Asia this week.</p>";

    expect(excerptFrom(null, body)).toBe("Base oil prices eased in Asia this week.");
  });

  it("cuts at a word rather than mid-word, and says it was cut", () => {
    const body = `<p>${"word ".repeat(100)}</p>`;
    const excerpt = excerptFrom("", body)!;

    expect(excerpt.length).toBeLessThanOrEqual(301);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toContain("wor…");
  });

  it("decodes the entities the old editor left behind", () => {
    expect(excerptFrom(null, "<p>Shell&nbsp;&amp; BP&rsquo;s view</p>")).toBe("Shell & BP’s view");
  });

  it("is null when there is genuinely nothing to show", () => {
    expect(excerptFrom(null, "")).toBeNull();
    expect(excerptFrom("", "<p></p>")).toBeNull();
  });
});

/**
 * The old `subscription_users` table is the transaction history: 635 rows on
 * baseoil with `payment_status` spelled three ways ("Paid", "success", null)
 * and 634 of the 635 carrying no order reference at all.
 */
describe("reading an old subscription payment", () => {
  it("treats both spellings of success as paid", () => {
    expect(readPaymentStatus("Paid")).toBe("paid");
    expect(readPaymentStatus("success")).toBe("paid");
    expect(readPaymentStatus("  SUCCESS ")).toBe("paid");
  });

  it("does not call an unrecorded payment paid", () => {
    expect(readPaymentStatus(null)).toBe("pending");
    expect(readPaymentStatus("")).toBe("pending");
  });

  it("records a refusal as failed rather than pending", () => {
    expect(readPaymentStatus("Failed")).toBe("failed");
    expect(readPaymentStatus("cancelled")).toBe("cancelled");
  });
});

describe("the terms a plan is sold for", () => {
  it("reads the three cost columns as one, two and three years", () => {
    expect(termsFrom(15000, 25000, 33000)).toEqual([
      { years: 1, amount: "15000.00" },
      { years: 2, amount: "25000.00" },
      { years: 3, amount: "33000.00" },
    ]);
  });

  it("leaves out a term that was never priced", () => {
    expect(termsFrom(540, null, 0)).toEqual([{ years: 1, amount: "540.00" }]);
  });

  it("has nothing to sell when the first year has no price", () => {
    expect(termsFrom(0, null, null)).toEqual([]);
  });
});

/**
 * Carrying coupons, which the content migration skipped entirely.
 *
 * All nine brands print the same `EARLY10` at 10% — nine rows saying one
 * thing, because each site had its own table. This schema makes `code`
 * unique across the estate with a null brand meaning "works everywhere", so
 * the nine collapse into one. `TESTER100` exists on bitumart alone and stays
 * bitumart's.
 *
 * The migration runs one brand at a time and cannot see the others, so the
 * decision has to be expressible from what is already in the table.
 */
describe("the brand a carried coupon belongs to", () => {
  const ten = { percentOff: 10, amountOff: null, enabled: true };

  it("scopes a code nobody has carried yet to the brand carrying it", () => {
    expect(couponAction(null, ten, 7)).toEqual({ action: "create", siteId: 7 });
  });

  it("broadens a code to the whole estate when a second brand has it identically", () => {
    expect(couponAction({ siteId: 3, ...ten }, ten, 7)).toEqual({ action: "broaden" });
  });

  it("leaves an already estate-wide code alone", () => {
    expect(couponAction({ siteId: null, ...ten }, ten, 7)).toEqual({ action: "keep" });
  });

  it("refuses to merge two codes that mean different things", () => {
    // Same word, different discount: broadening would silently change what
    // one brand's customers get.
    expect(couponAction({ siteId: 3, ...ten }, { ...ten, percentOff: 25 }, 7)).toEqual({
      action: "conflict",
    });
  });

  it("treats a disabled code as different terms from a live one", () => {
    expect(couponAction({ siteId: 3, ...ten }, { ...ten, enabled: false }, 7)).toEqual({
      action: "conflict",
    });
  });

  it("does nothing when the same brand carries its own code twice", () => {
    // A re-run with --fresh clears the brand's own rows first, but an
    // estate-wide code survives, so this must not fall into "broaden".
    expect(couponAction({ siteId: 7, ...ten }, ten, 7)).toEqual({ action: "keep" });
  });
});

/**
 * Which currency an old order was in.
 *
 * `subscription_users.currency_code` is free text and holds three different
 * things: the symbol (₹ on 271 baseoil rows, $ on 128), the ISO code (INR on
 * 8, USD on 3), and nothing at all (225). Upper-casing whatever was there —
 * which is what the first cut did — put `₹` and `$` into a column that is
 * supposed to carry ISO codes, so the admin ended up with four currencies
 * for two.
 *
 * `currency_id` is the field to trust: it points at the old `currencies`
 * master, where 1 is INR and 2 is USD.
 */
describe("reading the currency of an old order", () => {
  const master = new Map([
    [1, "INR"],
    [2, "USD"],
    [3, "EUR"],
  ]);

  it("trusts the id over the free text beside it", () => {
    expect(readCurrency(1, "₹", master, "USD")).toBe("INR");
    expect(readCurrency(2, "$", master, "INR")).toBe("USD");
  });

  it("accepts an ISO code when there is no id", () => {
    expect(readCurrency(null, "INR", master, "USD")).toBe("INR");
    expect(readCurrency(null, "usd", master, "INR")).toBe("USD");
  });

  it("recognises the symbol when that is all there is", () => {
    expect(readCurrency(null, "₹", master, "USD")).toBe("INR");
    expect(readCurrency(null, "$", master, "INR")).toBe("USD");
  });

  it("falls back to the plan's own currency when the row says nothing", () => {
    // 225 rows on baseoil. The plan priced the sale, so its currency is the
    // best evidence of what was charged.
    expect(readCurrency(null, null, master, "INR")).toBe("INR");
    expect(readCurrency(null, "", master, "USD")).toBe("USD");
  });

  it("never invents a code from text it does not recognise", () => {
    expect(readCurrency(null, "rupees", master, "USD")).toBe("USD");
    expect(readCurrency(99, "?", master, "USD")).toBe("USD");
  });
});

/**
 * Which profile row is the person's.
 *
 * `profiles` holds 18,421 rows for 17,297 users on baseoil, so about 1,124
 * people have more than one and something has to choose. This is where the
 * customer's country lives — the field the rupee/dollar split depends on —
 * so choosing badly loses a paying customer their price list.
 *
 * The fullest row wins, because these are duplicates from re-registration
 * rather than a history: one row usually has the address and company and the
 * other is a stub. A tie goes to the one touched most recently.
 */
describe("choosing between a person's profiles", () => {
  const stub = { countryId: null, companyName: null, address1: null, updatedAt: "2020-01-01" };

  it("takes the only row there is", () => {
    const row = { ...stub, countryId: 101 };

    expect(bestProfile([row])).toBe(row);
  });

  it("prefers the row that actually says something", () => {
    const full = { countryId: 101, companyName: "Apex Lubes", address1: "12 Marine Drive", updatedAt: "2019-01-01" };

    expect(bestProfile([stub, full])).toBe(full);
  });

  it("prefers the fuller row even when the stub is newer", () => {
    // A later empty re-registration must not erase an address and a country.
    const full = { countryId: 101, companyName: "Apex Lubes", address1: "12 Marine Drive", updatedAt: "2019-01-01" };
    const newer = { ...stub, updatedAt: "2026-01-01" };

    expect(bestProfile([newer, full])).toBe(full);
  });

  it("breaks a tie on which was touched last", () => {
    const older = { countryId: 101, companyName: "A", address1: null, updatedAt: "2019-01-01" };
    const newer = { countryId: 77, companyName: "B", address1: null, updatedAt: "2024-06-01" };

    expect(bestProfile([older, newer])).toBe(newer);
  });

  it("has nothing to choose from an empty list", () => {
    expect(bestProfile([])).toBeNull();
  });
});
