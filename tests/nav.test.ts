/**
 * The admin's three groups.
 *
 * The owner asked for Overview / Sites / Billing. The first attempt put the
 * groups in and left everything else where it was: People's five parts and
 * each brand's fourteen modules all sat in the rail, forty entries deep, and
 * the manager's verdict was that he could read it but a normal user could not.
 *
 * So the rail carries **places only** — seventeen entries, one level, nothing
 * that expands. A brand's modules are tabs inside the brand's page, which is
 * why `siteTabs` lives here beside `navFor`: same model, different depth.
 */
import { describe, expect, it } from "vitest";

import {
  brandContext,
  hasTradeAnalysis,
  navFor,
  siteTabs,
  type NavBrand,
  type NavSection,
} from "@/app/(admin)/nav";

const BRANDS: NavBrand[] = [
  { slug: "baseoil", name: "Base Oil Report", freshness: "stale" },
  { slug: "bitumart", name: "Bitumart", freshness: "due" },
  { slug: "waxreport", name: "Wax Report", freshness: "fresh" },
];

const group = (nav: NavSection[], name: string) => nav.find((s) => s.group === name)!;
const hrefs = (nav: NavSection[], name: string) => group(nav, name).items.map((i) => i.href);

describe("the three groups", () => {
  it("gives exactly Overview, Sites and Billing, in that order", () => {
    expect(navFor(BRANDS).map((s) => s.group)).toEqual(["Overview", "Sites", "Billing"]);
  });

  it("holds the whole estate in three Overview entries", () => {
    // Not seven. People's parts are tabs on its own page; "Activity" is what
    // the audit trail is called in words a normal user reads.
    expect(hrefs(navFor(BRANDS), "Overview")).toEqual([
      "/dashboard",
      "/dashboard/people",
      "/dashboard/audit",
    ]);
  });

  it("names Overview's entries plainly", () => {
    expect(group(navFor(BRANDS), "Overview").items.map((i) => i.label)).toEqual([
      "Dashboard",
      "People",
      "Activity",
    ]);
  });

  it("puts what access costs under Billing", () => {
    expect(hrefs(navFor(BRANDS), "Billing")).toEqual([
      "/dashboard/plans",
      "/dashboard/transactions",
      "/dashboard/coupons",
      "/dashboard/currencies",
    ]);
  });

  it("stays at sixteen entries for the nine real brands", () => {
    // The number is the point: the rail must fit on one screen without
    // scrolling, which is what forty entries did not.
    const nine = Array.from({ length: 9 }, (_, at) => ({
      slug: `brand${at}`,
      name: `Brand ${at}`,
      freshness: "fresh" as const,
    }));

    expect(navFor(nine).flatMap((s) => s.items)).toHaveLength(16);
  });

  it("never nests: no entry carries children of its own", () => {
    for (const item of navFor(BRANDS).flatMap((s) => s.items)) {
      expect(item).not.toHaveProperty("items");
    }
  });
});

describe("one entry per brand", () => {
  it("lists the brands the viewer can see, in the order given", () => {
    expect(group(navFor(BRANDS), "Sites").items.map((i) => i.label)).toEqual([
      "Base Oil Report",
      "Bitumart",
      "Wax Report",
    ]);
  });

  it("opens a brand on its own page, by slug and not by filter", () => {
    expect(hrefs(navFor(BRANDS), "Sites")).toEqual([
      "/dashboard/sites/baseoil",
      "/dashboard/sites/bitumart",
      "/dashboard/sites/waxreport",
    ]);
  });

  it("carries each brand's price freshness, for the dot and its legend", () => {
    expect(group(navFor(BRANDS), "Sites").items.map((i) => i.freshness)).toEqual([
      "stale",
      "due",
      "fresh",
    ]);
  });

  it("drops the Sites group entirely for a viewer with no brands", () => {
    expect(navFor([]).map((s) => s.group)).toEqual(["Overview", "Billing"]);
  });
});

describe("a brand's own tabs", () => {
  it("groups twenty modules into seven ideas", () => {
    expect(siteTabs("baseoil").map((t) => t.label)).toEqual([
      "Dashboard",
      "Prices",
      "Content",
      "Emailer",
      "Readers",
      "AI tools",
      "Settings",
    ]);
  });

  it("puts the brand in the path, not in a query parameter", () => {
    // Phase 1.5. While a module screen was `/dashboard/articles?site=baseoil`
    // it was an estate screen wearing a label: the brand sat in a dropdown,
    // the filter bar offered to change it, and Clear threw you back to all
    // nine. Pinning the dropdown hid that; the path removes it.
    const links = siteTabs("bitumart")
      .flatMap((tab) => tab.items)
      .filter((item) => item.built);

    expect(links.length).toBeGreaterThan(8);

    for (const item of links) {
      expect(item.href.startsWith("/dashboard/sites/bitumart/")).toBe(true);
      expect(item.href).not.toContain("?");
      expect(item.href).not.toContain("site=");
    }
  });

  it("gives every tab a landing path inside the brand", () => {
    for (const tab of siteTabs("waxreport")) {
      expect(tab.href.startsWith("/dashboard/sites/waxreport")).toBe(true);
    }
  });

  it("opens the brand itself on its dashboard tab", () => {
    expect(siteTabs("waxreport")[0]).toMatchObject({
      label: "Dashboard",
      href: "/dashboard/sites/waxreport",
    });
  });

  it("lands each other tab on its first working screen", () => {
    // A tab is a group of modules, not a page of its own. "Prices" should put
    // you on the markets list rather than on a menu of one more click.
    const prices = siteTabs("waxreport").find((tab) => tab.label === "Prices")!;

    expect(prices.href).toBe("/dashboard/sites/waxreport/locations");
  });

  it("gives trade analysis to baseoil alone", () => {
    // One of the five per-site route deltas: `admin/tradeanalysis/*` exists on
    // baseoil and on no other site. Offering it to the other eight would be
    // inventing a screen they never had.
    const labels = (slug: string) =>
      siteTabs(slug)
        .flatMap((tab) => tab.items)
        .map((item) => item.label);

    expect(labels("baseoil")).toContain("Trade analysis");
    expect(labels("bitumart")).not.toContain("Trade analysis");
  });

  it("says in words what is not built, rather than greying it out", () => {
    const unbuilt = siteTabs("baseoil")
      .flatMap((tab) => tab.items)
      .filter((item) => !item.built);

    expect(unbuilt.map((item) => item.label)).toContain("Sample reports");

    for (const item of unbuilt) {
      expect(item.note).toBeTruthy();
    }
  });

  it("gives every module a plain second line, so nobody has to guess", () => {
    for (const item of siteTabs("baseoil").flatMap((tab) => tab.items)) {
      expect(item.note).toBeTruthy();
    }
  });
});

describe("the emailer", () => {
  // Easy to miss, and large. The old admin sends four different kinds of mail
  // from four separate modules, and the first version of this nav collapsed
  // all of them into one card called "Report mail-outs". The real thing on
  // baseoil: 12 system templates over a country pivot, 415 newsletters, 210
  // report sends to 8,931 recipients, 318 sample sends, and a 17,052-row
  // delivery log with open tracking.
  it("gives sending its own tab rather than a single card", () => {
    expect(siteTabs("baseoil").map((t) => t.label)).toContain("Emailer");
  });

  it("keeps the four kinds of mail apart, because they are four screens", () => {
    const emailer = siteTabs("baseoil").find((t) => t.label === "Emailer")!;

    expect(emailer.items.map((i) => i.label)).toEqual([
      "Newsletters",
      "Newsletter templates",
      "Email templates",
      "Send a report",
      "Send a sample",
      "Delivery log",
    ]);
  });

  it("names what already works and what does not", () => {
    const emailer = siteTabs("baseoil").find((t) => t.label === "Emailer")!;
    const built = (label: string) => emailer.items.find((i) => i.label === label)!.built;

    expect(built("Newsletters")).toBe(true);
    expect(built("Newsletter templates")).toBe(true);
    expect(built("Email templates")).toBe(true);
    // The report-delivery machine: send, sample, and the log of both.
    expect(built("Send a report")).toBe(true);
    expect(built("Send a sample")).toBe(true);
    expect(built("Delivery log")).toBe(true);
  });

  it("still groups a brand into no more than seven tabs", () => {
    expect(siteTabs("baseoil").length).toBeLessThanOrEqual(7);
  });
});

describe("the cards tell the truth", () => {
  it("never points two cards in a tab at the same screen", () => {
    // Two cards reading "Markets" and "Price grid" both linked to
    // `/dashboard/locations`. Offering the same screen under two names is
    // exactly the confusion the three groups were meant to remove.
    for (const tab of siteTabs("baseoil")) {
      const links = tab.items.filter((item) => item.built).map((item) => item.href);

      expect(new Set(links).size).toBe(links.length);
    }
  });

  it("does not claim price entry exists, because it does not", () => {
    // The only action on the markets screens is show/hide. Prices reach this
    // platform through the module's batch commit; the old admin's per-market
    // grid, its bulk update, its bulk delete and its by-date screens have no
    // equivalent here at all.
    const prices = siteTabs("baseoil").find((tab) => tab.label === "Prices")!;
    const entry = prices.items.find((item) => item.label === "Enter prices by hand")!;

    expect(entry.built).toBe(false);
  });

  it("marks a card built only when the screen behind it exists", () => {
    const under = (route: string) => `/dashboard/sites/baseoil/${route}`;
    // Every built card points at a real admin route. Checked against the
    // screens the app actually has, so a card cannot quietly outlive one.
    const real = new Set(
      [
        "locations",
        "qty",
        "impex",
        "articles",
        "reports",
        "offers",
        "announcements",
        "pages",
        "categories",
        "files",
        "newsletters",
        "templates",
        "ads",
        "ad-locations",
        "batches",
        "crawl",
        "trade-analysis",
        "settings",
        "settings/directory",
        "settings/offers",
        "settings/mail-templates",
        "enquiries",
        "send-report",
        "send-sample",
        "deliveries",
      ].map(under),
    );

    for (const tab of siteTabs("baseoil")) {
      for (const item of tab.items.filter((i) => i.built)) {
        expect(real).toContain(item.href);
      }
    }
  });
});

describe("standing inside a brand", () => {
  // The whole claim of the Sites group is "the brand is where you are
  // standing". A module screen reached from a brand then showed a "Brand"
  // dropdown offering all nine — which says the opposite, and makes the
  // section look like a filter with extra steps.
  const seen = [
    { id: 1, slug: "baseoil", name: "Base Oil Report" },
    { id: 2, slug: "bitumart", name: "Bitumart" },
  ];

  it("pins the brand when the screen was opened from one", () => {
    expect(brandContext(seen, "bitumart")).toEqual({
      kind: "pinned",
      slug: "bitumart",
      name: "Bitumart",
      href: "/dashboard/sites/bitumart",
    });
  });

  it("offers the picker on an estate-wide screen", () => {
    expect(brandContext(seen, undefined)).toEqual({ kind: "picker" });
    expect(brandContext(seen, "")).toEqual({ kind: "picker" });
  });

  it("offers the picker for a brand the viewer cannot see", () => {
    // Not pinned to a name we would then print: an unknown or forbidden slug
    // must not become a label.
    expect(brandContext(seen, "waxreport")).toEqual({ kind: "picker" });
  });

  it("shows nothing at all to someone with a single brand", () => {
    // A per-site editor has one brand. A dropdown of one is furniture, and so
    // is a pin telling them where they already are.
    const one = [{ id: 1, slug: "baseoil", name: "Base Oil Report" }];

    expect(brandContext(one, undefined)).toEqual({ kind: "none" });
    expect(brandContext(one, "baseoil")).toEqual({ kind: "none" });
  });

  it("shows nothing when the viewer has no brands", () => {
    expect(brandContext([], undefined)).toEqual({ kind: "none" });
  });
});

describe("a screen only one brand has", () => {
  // Trade analysis exists on baseoil and on no other site — one of the five
  // per-site route deltas. Leaving the menu to enforce that is not enforcing
  // it: `/dashboard/sites/bitumart/trade-analysis` answered perfectly well
  // for a brand that has never had the screen.
  it("says which brands have trade analysis", () => {
    expect(hasTradeAnalysis("baseoil")).toBe(true);
    expect(hasTradeAnalysis("bitumart")).toBe(false);
    expect(hasTradeAnalysis("waxreport")).toBe(false);
  });

  it("agrees with the tab it appears in", () => {
    for (const slug of ["baseoil", "bitumart"]) {
      const labels = siteTabs(slug)
        .flatMap((tab) => tab.items)
        .map((item) => item.label);

      expect(labels.includes("Trade analysis")).toBe(hasTradeAnalysis(slug));
    }
  });
});

describe("enquiries", () => {
  it("has a working inbox under Readers", () => {
    const readers = siteTabs("baseoil").find((t) => t.label === "Readers")!;
    const enquiries = readers.items.find((i) => i.label === "Enquiries")!;

    expect(enquiries.built).toBe(true);
    expect(enquiries.href).toBe("/dashboard/sites/baseoil/enquiries");
  });
});
