"use client";

/**
 * The left rail: three groups, sixteen entries, one level deep.
 *
 * A client component only because it needs to know which screen is open,
 * which is the one thing the server cannot tell it on a shared layout.
 *
 * Matching got much simpler than it was. The old rail had to score items
 * against the query string, because the Directory group pointed seven entries
 * at `/dashboard/clients` and told them apart by `?segment=`. Those seven are
 * now filters inside the People page, so an entry here matches on path alone
 * — with one wrinkle kept: a brand's module screens live at estate paths like
 * `/dashboard/articles?site=baseoil`, so while you are on one of those the
 * rail lights up that brand rather than nothing at all.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { PEOPLE_TABS, navFor, type Freshness, type NavBrand } from "./nav";

const DOT: Record<Freshness, string> = {
  fresh: "ok",
  due: "warn",
  stale: "bad",
  none: "",
};

const SAYS: Record<Freshness, string> = {
  fresh: "prices up to date",
  due: "update due",
  stale: "overdue",
  none: "no prices yet",
};

/**
 * Which entry is open.
 *
 * A brand's page is `/dashboard/sites/<slug>`; its modules are estate screens
 * carrying `?site=<slug>`. Both should light the same brand, so the site
 * parameter wins over the path when it names a brand the viewer can see.
 */
function currentHref(path: string, site: string | null, brands: NavBrand[]): string | null {
  if (site && brands.some((brand) => brand.slug === site)) {
    return `/dashboard/sites/${site}`;
  }

  // People's five screens sit at their own estate paths, not under
  // /dashboard/people, and without this they lit up Dashboard instead.
  if (PEOPLE_TABS.some((tab) => path === tab.href || path.startsWith(`${tab.href}/`))) {
    return "/dashboard/people";
  }

  const all = navFor(brands).flatMap((group) => group.items);
  const matches = all
    .filter((item) => item.href === path || path.startsWith(`${item.href}/`))
    // The longest matching path wins, so `/dashboard/people` beats
    // `/dashboard` on the People page.
    .sort((a, b) => b.href.length - a.href.length);

  return matches[0]?.href ?? null;
}

export function Rail({ brands }: { brands: NavBrand[] }) {
  const path = usePathname();
  const params = useSearchParams();
  const current = currentHref(path, params.get("site"), brands);

  return (
    <nav className="rail" aria-label="Admin">
      <div className="rail-head">
        <strong>Petrosil</strong>
        <span>
          one admin, {brands.length} brand{brands.length === 1 ? "" : "s"}
        </span>
      </div>

      {navFor(brands).map((group) => (
        <div key={group.group}>
          {group.group === "Sites" ? (
            // The dots mean nothing without this, and an unexplained colour is
            // worse than no colour. It sits beside the heading, where the eye
            // already is when it reads the list below.
            <div className="rail-group with-legend">
              <span>{group.group}</span>
              <span className="rail-legend">
                <span>
                  <i className="freshdot ok" /> up to date
                </span>
                <span>
                  <i className="freshdot warn" /> due
                </span>
                <span>
                  <i className="freshdot bad" /> overdue
                </span>
              </span>
            </div>
          ) : (
            <div className="rail-group">{group.group}</div>
          )}

          {group.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={item.href === current ? "on" : undefined}
            >
              <span className="rail-label">{item.label}</span>
              {item.freshness ? (
                <span
                  className={`freshdot ${DOT[item.freshness]}`}
                  title={SAYS[item.freshness]}
                  aria-label={SAYS[item.freshness]}
                />
              ) : null}
            </Link>
          ))}

        </div>
      ))}
    </nav>
  );
}
