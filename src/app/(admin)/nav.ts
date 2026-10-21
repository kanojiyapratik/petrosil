/**
 * The admin's left rail, taken from the nine PHP admins it replaces.
 *
 * The groups and their order are lifted from
 * `htdocs/baseoil/baseoil/application/resources/views/layouts/app.blade.php`
 * — Content, Masters, User Directory, Subscription Plan, Ads, Users,
 * Newsletter, Settings — because the people using this have opened the same
 * menu every working day since 2015 and should not have to hunt.
 *
 * What is NOT carried over: the purchased theme's demo pages (chat, calendar,
 * gallery, invoice, lock-screen, sweet-alert, forty more). They are roughly
 * 45% of the old route table and none of them is a feature.
 *
 * `built: false` means the old admin had this screen and this one does not
 * yet. They are shown greyed rather than hidden: hiding them would
 * misrepresent the shape of the system to someone who knows it, and
 * pretending they work would be worse than either.
 */

export type NavItem = { label: string; href: string; built: boolean };
export type NavGroup = { group: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    group: "Dashboard",
    items: [{ label: "Estate overview", href: "/dashboard", built: true }],
  },
  {
    group: "Prices",
    items: [
      { label: "Locations", href: "/dashboard/locations", built: true },
      { label: "Price update", href: "/dashboard/batches", built: true },
      { label: "Watched URLs", href: "/dashboard/crawl", built: false },
      { label: "Manage qty trend", href: "/dashboard/qty", built: false },
      { label: "Trade analysis", href: "/dashboard/trade-analysis", built: false },
    ],
  },
  {
    group: "Content",
    items: [
      { label: "Articles", href: "/dashboard/articles", built: true },
      { label: "Pages", href: "/dashboard/pages", built: false },
      { label: "Announcements", href: "/dashboard/announcements", built: false },
      { label: "Reports", href: "/dashboard/reports", built: false },
      { label: "Offers", href: "/dashboard/offers", built: false },
      { label: "Impex data", href: "/dashboard/impex", built: false },
    ],
  },
  {
    group: "Clients",
    items: [
      { label: "Directory", href: "/dashboard/clients", built: true },
      { label: "Free trials", href: "/dashboard/trials", built: true },
      { label: "Login log", href: "/dashboard/logins", built: true },
    ],
  },
  {
    group: "Subscription",
    items: [
      { label: "Plans", href: "/dashboard/plans", built: false },
      { label: "Transactions", href: "/dashboard/transactions", built: false },
      { label: "Coupons", href: "/dashboard/coupons", built: false },
    ],
  },
  {
    group: "Masters",
    items: [
      { label: "Currencies", href: "/dashboard/currencies", built: false },
      { label: "Categories", href: "/dashboard/categories", built: false },
      { label: "File manager", href: "/dashboard/files", built: false },
    ],
  },
  {
    group: "Newsletter",
    items: [
      { label: "Templates", href: "/dashboard/templates", built: false },
      { label: "Newsletters", href: "/dashboard/newsletters", built: false },
    ],
  },
  {
    group: "Ads",
    items: [
      { label: "Ad locations", href: "/dashboard/ad-locations", built: false },
      { label: "Ads", href: "/dashboard/ads", built: false },
    ],
  },
  {
    group: "Users",
    items: [
      { label: "Staff", href: "/dashboard/staff", built: false },
      { label: "Roles", href: "/dashboard/roles", built: false },
      { label: "Audit trail", href: "/dashboard/audit", built: true },
    ],
  },
  {
    group: "Settings",
    items: [
      { label: "General", href: "/dashboard/settings", built: false },
      { label: "Directory fields", href: "/dashboard/settings/directory", built: false },
      { label: "Offer fields", href: "/dashboard/settings/offers", built: false },
    ],
  },
];

/** How many of the old admin's screens exist here, for the honest line in the rail. */
export const BUILT = NAV.flatMap((g) => g.items).filter((i) => i.built).length;
export const TOTAL = NAV.flatMap((g) => g.items).length;
