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
