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
 * `built` is honest signposting rather than decoration: a screen marked
 * false is listed and greyed, because hiding it would misrepresent the shape
 * of the system to somebody who knows the old admin, and pretending it works
 * would be worse than either. All 31 are built now; the flag stays for the
 * next one somebody asks for.
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
      { label: "Watched URLs", href: "/dashboard/crawl", built: true },
      { label: "Manage qty trend", href: "/dashboard/qty", built: true },
      { label: "Trade analysis", href: "/dashboard/trade-analysis", built: true },
    ],
  },
  {
    group: "Content",
    items: [
      { label: "Articles", href: "/dashboard/articles", built: true },
      { label: "Pages", href: "/dashboard/pages", built: true },
      { label: "Announcements", href: "/dashboard/announcements", built: true },
      { label: "Reports", href: "/dashboard/reports", built: true },
      { label: "Offers", href: "/dashboard/offers", built: true },
      { label: "Impex data", href: "/dashboard/impex", built: true },
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
      { label: "Plans", href: "/dashboard/plans", built: true },
      { label: "Transactions", href: "/dashboard/transactions", built: true },
      { label: "Coupons", href: "/dashboard/coupons", built: true },
    ],
  },
  {
    group: "Masters",
    items: [
      { label: "Currencies", href: "/dashboard/currencies", built: true },
      { label: "Categories", href: "/dashboard/categories", built: true },
      { label: "File manager", href: "/dashboard/files", built: true },
    ],
  },
  {
    group: "Newsletter",
    items: [
      { label: "Templates", href: "/dashboard/templates", built: true },
      { label: "Newsletters", href: "/dashboard/newsletters", built: true },
    ],
  },
  {
    group: "Ads",
    items: [
      { label: "Ad locations", href: "/dashboard/ad-locations", built: true },
      { label: "Ads", href: "/dashboard/ads", built: true },
    ],
  },
  {
    group: "Users",
    items: [
      { label: "Staff", href: "/dashboard/staff", built: true },
      { label: "Roles", href: "/dashboard/roles", built: true },
      { label: "Audit trail", href: "/dashboard/audit", built: true },
    ],
  },
  {
    group: "Settings",
    items: [
      { label: "General", href: "/dashboard/settings", built: true },
      { label: "Directory fields", href: "/dashboard/settings/directory", built: true },
      { label: "Offer fields", href: "/dashboard/settings/offers", built: true },
    ],
  },
];

/** How many of the old admin's screens exist here, for the honest line in the rail. */
export const BUILT = NAV.flatMap((g) => g.items).filter((i) => i.built).length;
export const TOTAL = NAV.flatMap((g) => g.items).length;
