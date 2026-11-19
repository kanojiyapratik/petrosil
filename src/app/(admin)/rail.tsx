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

import Link from "@/lib/ui/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { PEOPLE_TABS, navFor, type NavBrand } from "./nav";

/**
 * Which entry is open.
 *
 * A brand's page is `/dashboard/sites/<slug>`; its modules are estate screens
 * carrying `?site=<slug>`. Both should light the same brand, so the site
 * parameter wins over the path when it names a brand the viewer can see.
 */
function currentHref(path: string, site: string | null, brands: NavBrand[]): string | null {
  // A brand's own pages belong to no rail entry now that the rail lists no
  // brands; without this the Dashboard entry lit up on every one of them,
  // because `/dashboard` is a prefix of `/dashboard/sites/...`. The header
  // picker shows which brand you are in.
  if (path.startsWith("/dashboard/sites/") || (site && brands.some((brand) => brand.slug === site))) {
    return null;
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
  // Only a phone ever sees it closed: the toggle and the hiding are both in
  // the narrow-screen CSS. Opening a screen closes it again.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [path]);

  return (
    <nav className={open ? "rail open" : "rail"} aria-label="Admin">
      <div className="rail-head">
        <div>
          <strong>Petrosil</strong>
          <span>
            one admin, {brands.length} brand{brands.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          className="rail-toggle"
          aria-expanded={open}
          aria-controls="rail-links"
          onClick={() => setOpen((was) => !was)}
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>

      <div className="rail-links" id="rail-links">
        {navFor(brands).map((group) => (
          <div key={group.group}>
            <div className="rail-group">{group.group}</div>

            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={item.href === current ? "on" : undefined}
                onClick={() => setOpen(false)}
              >
                <span className="rail-label">{item.label}</span>
              </Link>
            ))}

          </div>
        ))}
      </div>
    </nav>
  );
}
