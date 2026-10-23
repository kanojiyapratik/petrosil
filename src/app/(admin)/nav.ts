/**
 * The admin's left rail, taken from the nine PHP admins it replaces.
 *
 * Read out of `htdocs/baseoil/baseoil/application/resources/views/layouts/
 * app.blade.php` — the group order from the list at lines 713-793, the items
 * from each group's own block. Not approximated: the manager who uses the old
 * admin daily said this one was not aligned with it, and he was right. The
 * first version renamed Directory to "Clients", moved Newsletter out of
 * Settings, invented a "Prices" group, reordered everything, and collapsed
 * eight daily-use screens into four filter chips.
 *
 * So the labels, the order and the grouping are the old ones, including the
 * parts that read oddly:
 *
 *   - "Global Price Trend" is what the old admin calls the locations screen.
 *     It appears there twice, pointing at two different routes; this is the
 *     one that manages locations.
 *   - The price screens live inside Content, after Pages, because that is
 *     where the price module appended them.
 *   - "Currency" and "Category" are singular, as they are there.
 *
 * What is NOT carried over: the purchased theme's demo pages — chat,
 * calendar, gallery, invoice, lock-screen, forty more. They are roughly 45%
 * of the old route table and none of them is a feature.
 *
 * `built: false` means the old admin had this screen and this one does not
 * yet. They are shown greyed rather than hidden: hiding them is what made
 * the menu unrecognisable in the first place.
 */

export type NavItem = { label: string; href: string; built: boolean };
export type NavGroup = { group: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    group: "Dashboards",
    items: [{ label: "Estate overview", href: "/dashboard", built: true }],
  },
  {
    group: "Content",
    items: [
      { label: "Articles", href: "/dashboard/articles", built: true },
      { label: "Offers", href: "/dashboard/offers", built: true },
      { label: "Reports", href: "/dashboard/reports", built: true },
      // `samplereports` holds one row on baseoil and has no table here.
      { label: "Sample Reports", href: "/dashboard/sample-reports", built: false },
      { label: "Impex Data", href: "/dashboard/impex", built: true },
      { label: "Announcements", href: "/dashboard/announcements", built: true },
      { label: "Pages", href: "/dashboard/pages", built: true },
      { label: "Global Price Trend", href: "/dashboard/locations", built: true },
      { label: "Price Update", href: "/dashboard/batches", built: true },
      { label: "Watched URLs", href: "/dashboard/crawl", built: true },
      { label: "Manage Qty Trend", href: "/dashboard/qty", built: true },
      { label: "Trade Analysis", href: "/dashboard/trade-analysis", built: true },
    ],
  },
  {
    group: "Masters",
    items: [
      // `products` holds 4 rows per brand and has no table here.
      { label: "Products", href: "/dashboard/products", built: false },
      { label: "Currency", href: "/dashboard/currencies", built: true },
      { label: "Category", href: "/dashboard/categories", built: true },
      { label: "File Manager", href: "/dashboard/files", built: true },
    ],
  },
  {
    group: "Directory",
    items: [
      { label: "Directory", href: "/dashboard/clients", built: true },
      { label: "Free Users", href: "/dashboard/clients?segment=free", built: true },
      { label: "Premium Users", href: "/dashboard/clients?segment=premium", built: true },
      {
        label: "Expired Premium Users",
        href: "/dashboard/clients?segment=expired",
        built: true,
      },
      // The old screen routes this to `premium = 1` with no date filter at
      // all -- the same set as Premium Users, so the name never meant
      // anything there. Here it is what it says: paying, and due inside 30
      // days.
      {
        label: "Upcoming Renewal",
        href: "/dashboard/clients?segment=premium&due=30",
        built: true,
      },
      { label: "Trial Users", href: "/dashboard/clients?segment=trial", built: true },
      {
        label: "Expired Trial Users",
        href: "/dashboard/clients?segment=trial_expired",
        built: true,
      },
      // The old sites keep `user_status` as free text and this schema
      // flattens it to active/disabled, so these two cannot be told apart
      // yet. Greyed rather than built as two screens showing one list --
      // and baseoil holds none of either.
      { label: "Inactive Users", href: "/dashboard/clients?segment=inactive", built: false },
      { label: "Suspended Users", href: "/dashboard/clients?segment=suspended", built: false },
      { label: "Login Log", href: "/dashboard/logins", built: true },
    ],
  },
  {
    group: "Subscription",
    items: [
      { label: "Plans", href: "/dashboard/plans", built: true },
      { label: "Transactions", href: "/dashboard/transactions", built: true },
      { label: "Coupons", href: "/dashboard/coupons", built: true },
    ],
  },
  {
    group: "Ads",
    items: [
      { label: "Ad Locations", href: "/dashboard/ad-locations", built: true },
      { label: "Ads", href: "/dashboard/ads", built: true },
    ],
  },
  {
    group: "Users",
    items: [
      { label: "Users", href: "/dashboard/staff", built: true },
      { label: "Roles", href: "/dashboard/roles", built: true },
      // No equivalent in the old admin, which had no audit trail at all --
      // it kept submittedby/modifiedby columns on forty tables instead.
      { label: "Audit trail", href: "/dashboard/audit", built: true },
    ],
  },
  {
    group: "Newsletter",
    items: [
      { label: "Newsletter Template", href: "/dashboard/templates", built: true },
      { label: "Newsletters", href: "/dashboard/newsletters", built: true },
    ],
  },
  {
    group: "Settings",
    items: [
      { label: "General Settings", href: "/dashboard/settings", built: true },
      { label: "Directory Settings", href: "/dashboard/settings/directory", built: true },
      { label: "Offers Settings", href: "/dashboard/settings/offers", built: true },
      // The old `settings` table carries the SMTP and provider credentials
      // this screen would edit. They are not ours to move.
      { label: "Mails Settings", href: "/dashboard/settings/mail", built: false },
    ],
  },
];

/** How many of the old admin's screens exist here, for the honest line in the rail. */
export const BUILT = NAV.flatMap((g) => g.items).filter((i) => i.built).length;
export const TOTAL = NAV.flatMap((g) => g.items).length;
