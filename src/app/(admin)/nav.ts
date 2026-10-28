/**
 * The admin's groups: Overview, Sites, Billing, and Global settings.
 *
 * Two earlier versions of this file are worth remembering, because each was
 * wrong in a different way.
 *
 * The first invented its own menu. The manager who uses the old admin daily
 * said it was not aligned with it, and he was right: it renamed Directory to
 * "Clients", invented a "Prices" group, and collapsed eight daily-use screens
 * into four filter chips.
 *
 * The second copied the old Blade sidebar exactly — nine groups, thirty-eight
 * entries, the old labels down to "Global Price Trend" and the singular
 * "Currency". That was faithful and still wrong, because the old sidebar was
 * itself a copy of a purchased theme's and could not express "this brand" at
 * all. Nine separate admins never needed to.
 *
 * So: the owner's three groups, and one rule that the first two versions both
 * broke. **The rail carries places, never modules.** Seventeen entries, one
 * level, nothing that expands — it has to fit on one screen without
 * scrolling. A brand's fourteen modules are tabs inside the brand's own page
 * (`siteTabs` below), grouped into six ideas instead of fourteen links.
 *
 * What is not carried over: the purchased theme's demo pages — chat,
 * calendar, gallery, invoice, lock-screen, some seventy more, roughly 45% of
 * the old route table and not one of them a feature.
 */

/** How long a brand has gone without a price, judged against its own cadence. */
export type Freshness = "fresh" | "due" | "stale" | "none";

export type NavBrand = { slug: string; name: string; freshness: Freshness };

export type NavItem = { label: string; href: string; freshness?: Freshness };
export type NavSection = { group: string; items: NavItem[] };

/**
 * The rail.
 *
 * Overview holds what belongs to the whole estate; Sites holds one entry per
 * brand the viewer may see; Billing holds what access costs; Global settings
 * holds what every brand shares. A viewer with no brands gets no Sites group
 * rather than an empty heading.
 */
export function navFor(brands: NavBrand[]): NavSection[] {
  const sections: NavSection[] = [
    {
      group: "Overview",
      items: [
        { label: "Dashboard", href: "/dashboard" },
        // The owner's wording: the entire user flow, self-registered
        // subscribers and Petrosil team alike. Its five parts are tabs.
        { label: "People", href: "/dashboard/people" },
        // "Audit trail" is what we called it; "Activity" is what it is.
        { label: "Activity", href: "/dashboard/audit" },
      ],
    },
  ];

  if (brands.length > 0) {
    sections.push({
      group: "Sites",
      items: brands.map((brand) => ({
        label: brand.name,
        href: `/dashboard/sites/${brand.slug}`,
        freshness: brand.freshness,
      })),
    });
  }

  sections.push({
    group: "Billing",
    items: [
      { label: "Plans and pricing", href: "/dashboard/plans" },
      { label: "Payments", href: "/dashboard/transactions" },
      { label: "Coupons", href: "/dashboard/coupons" },
    ],
  });

  // What every brand has its own copy of, edited once and applied to the
  // brands ticked; and the currencies, which are one list for all of them.
  sections.push({
    group: "Global settings",
    items: [
      { label: "System emails", href: "/dashboard/global/emails" },
      { label: "Common pages", href: "/dashboard/global/pages" },
      { label: "Field visibility", href: "/dashboard/global/visibility" },
      { label: "Ad slots", href: "/dashboard/global/ad-slots" },
      { label: "Categories", href: "/dashboard/global/categories" },
      { label: "Currencies", href: "/dashboard/currencies" },
    ],
  });

  return sections;
}

export type SiteModule = {
  label: string;
  /** A real path under the brand. No query parameter decides which brand. */
  href: string;
  /** The plain second line. Every module has one; nobody should have to guess. */
  note: string;
  built: boolean;
};

export type SiteTab = {
  label: string;
  slug: string;
  /** Where the tab lands: the brand itself, or its first working screen. */
  href: string;
  items: SiteModule[];
};

/** Brands whose old admin had the trade-analysis screens. Inventory §2. */
const TRADE_ANALYSIS = new Set(["baseoil"]);

/**
 * Whether this brand has trade analysis at all.
 *
 * Exported because the screen itself has to ask. The route lives under
 * `[slug]` like every other module, so it answers for all nine brands unless
 * something refuses -- and leaving that to the menu is not enforcement: the
 * URL worked perfectly well for a brand that never had the screen.
 */
export function hasTradeAnalysis(slug: string): boolean {
  return TRADE_ANALYSIS.has(slug);
}

type Spec = { label: string; slug: string; items: [string, string, string, boolean][] };

/**
 * The modules, as [label, route under the brand, note, built].
 *
 * Worth being exact about Prices. Price figures reach this platform by the
 * module committing a batch, and the only action on the markets screens is
 * show or hide. The old admin edited prices by hand in four places — a
 * per-market grid, a bulk update, a bulk delete and a by-date view. The grid
 * (price-entry) writes through a batch like the module does. The other three
 * are one screen (price-date): a published past price is never edited in
 * place, so a wrong one is withdrawn — audited, and it can be put back — and
 * re-entered on the grid.
 *
 * The Emailer tab is its own because the old admin sends four different kinds
 * of mail from four separate modules, and an earlier version collapsed all of
 * them into one card reading "Report mail-outs". On baseoil that single card
 * stood for 12 system templates over a country pivot, 415 newsletters, 210
 * report sends to 8,931 recipients, 318 sample sends, and a 17,052-row
 * delivery log with open tracking.
 */
/*
 * Pages, categories, system emails, ad slots and field visibility are not
 * here: every brand has them, so they are edited once under Global settings,
 * with the brands to apply them to ticked there. Listing them in each brand
 * as well would be the same thing in two places.
 */
const SPECS: Spec[] = [
  { label: "Dashboard", slug: "dashboard", items: [] },
  {
    label: "Prices",
    slug: "prices",
    items: [
      ["Markets", "locations", "show, hide, and each market's history", true],
      ["Enter prices by hand", "price-entry", "the old per-market grid", true],
      ["Correct a whole date", "price-date", "withdraw wrong figures and re-enter them", true],
      ["Import and export quantities", "qty", "by market and year", true],
      ["Trade data", "impex", "impex sheets as published", true],
    ],
  },
  {
    label: "Content",
    slug: "content",
    items: [
      ["Articles", "articles", "write and publish", true],
      ["Reports", "reports", "paid research", true],
      ["Member offers", "offers", "what members post", true],
      ["Announcements", "announcements", "site notices", true],
      ["Files", "files", "images and attachments", true],
      ["Sample reports", "sample-reports", "free reports for prospects", true],
    ],
  },
  {
    label: "Emailer",
    slug: "emailer",
    items: [
      ["Newsletters", "newsletters", "write and send to a list", true],
      ["Newsletter templates", "templates", "the layouts a newsletter uses", true],
      ["Send a report", "send-report", "to every paying reader", true],
      ["Send a sample", "send-sample", "reports to one prospect", true],
      ["Delivery log", "deliveries", "who was sent what, and who opened it", true],
    ],
  },
  {
    label: "Readers",
    slug: "readers",
    items: [
      // The old `messages` module was seven empty functions with no screen,
      // while the public forms kept writing into it: 1,189 unread on bitumart.
      ["Enquiries", "enquiries", "messages to companies, offers, plans", true],
      ["Adverts", "ads", "campaigns and clicks", true],
    ],
  },
  {
    label: "AI tools",
    slug: "ai",
    items: [
      ["Price update", "batches", "what the module staged", true],
      ["Watched pages", "crawl", "where prices are read from", true],
      ["Published AI note", "ai-note", "the note above the prices", true],
      ["Per-market rules", "rules", "prices worked out from others, read from the console", true],
    ],
  },
  {
    label: "Settings",
    slug: "settings",
    items: [
      ["General", "settings", "title, description, keywords", true],
      // The old `settings` table carries the SMTP and provider credentials
      // this screen would edit. They are not ours to move.
      ["Mail credentials", "settings/mail", "stays on the old host", false],
    ],
  },
];

/**
 * A brand's own page, as seven tabs.
 *
 * Every link is a path under `/dashboard/sites/<slug>/`, and that is the
 * whole point of the change. While these were estate screens carrying
 * `?site=<slug>`, the brand lived in a dropdown that offered to change it,
 * the filter bar's Clear threw you back to all nine, and a brand's section
 * was a filter with extra steps rather than a place.
 */
export function siteTabs(slug: string): SiteTab[] {
  const home = `/dashboard/sites/${slug}`;

  return SPECS.map((spec) => {
    const items: SiteModule[] = spec.items.map(([label, route, note, built]) => ({
      label,
      href: `${home}/${route}`,
      note,
      built,
    }));

    // One of the five per-site route deltas: `admin/tradeanalysis/*` exists on
    // baseoil and on no other site. Offering it to the other eight would be
    // inventing a screen they never had.
    if (spec.slug === "ai" && TRADE_ANALYSIS.has(slug)) {
      items.splice(2, 0, {
        label: "Trade analysis",
        href: `${home}/trade-analysis`,
        note: "customs sheets, read by AI",
        built: true,
      });
    }

    // A tab is a group of modules, not a page of its own, so it lands on its
    // first working screen rather than on a menu costing one more click.
    const landing = items.find((item) => item.built)?.href ?? home;

    return {
      label: spec.label,
      slug: spec.slug,
      href: spec.slug === "dashboard" ? home : landing,
      items,
    };
  });
}

/** The five parts of People, as tabs on its own page. */
export const PEOPLE_TABS = [
  { label: "Customers", slug: "customers", href: "/dashboard/clients" },
  { label: "Trial requests", slug: "trials", href: "/dashboard/trials" },
  { label: "Petrosil team", slug: "team", href: "/dashboard/staff" },
  { label: "What they can do", slug: "roles", href: "/dashboard/roles" },
  { label: "Sign-ins", slug: "logins", href: "/dashboard/logins" },
] as const;

/**
 * Whether a screen is standing inside a brand, or looking across the estate.
 *
 * Every module screen carries a brand filter, and when the screen was reached
 * from a brand's own section that filter was a "Brand" dropdown offering all
 * nine. That contradicts the thing the Sites group claims — the brand is
 * where you are standing, not something you pick again on arrival — and it
 * made each section look like a filter with extra steps.
 *
 * So the same control has three states:
 *
 *   - **pinned**: the URL names a brand the viewer may see. Show the brand's
 *     name as context, with a way back to its page, and carry the slug
 *     through any filtering rather than offering to change it.
 *   - **picker**: an estate-wide screen, or a slug that is unknown or not
 *     theirs. An unknown slug must never be turned into a printed label.
 *   - **none**: fewer than two brands. A dropdown of one is furniture, and so
 *     is telling a per-site editor which brand they are in.
 */
export type BrandContext =
  | { kind: "pinned"; slug: string; name: string; href: string }
  | { kind: "picker" }
  | { kind: "none" };

export function brandContext(
  brands: { slug: string; name: string }[],
  site: string | null | undefined,
): BrandContext {
  if (brands.length < 2) {
    return { kind: "none" };
  }

  const found = site ? brands.find((brand) => brand.slug === site) : undefined;

  if (!found) {
    return { kind: "picker" };
  }

  return {
    kind: "pinned",
    slug: found.slug,
    name: found.name,
    href: `/dashboard/sites/${found.slug}`,
  };
}
