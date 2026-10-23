"use client";

/**
 * The left rail. A client component only because it needs to know which
 * screen is open, which is the one thing the server cannot tell it on a
 * shared layout.
 *
 * Matching has to read the query string, not just the path: the Directory
 * group points seven items at `/dashboard/clients` and tells them apart by
 * `?segment=`, so on path alone all seven would light up together.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { BUILT, NAV, TOTAL } from "./nav";

/** How well an item matches where we are. Higher wins; 0 means it does not. */
function score(href: string, path: string, params: URLSearchParams): number {
  const [itemPath = href, itemQuery = ""] = href.split("?");

  if (itemPath !== path && !path.startsWith(`${itemPath}/`)) {
    return 0;
  }

  const wanted = new URLSearchParams(itemQuery);

  // Every parameter the item names must be present with that value, so
  // `?segment=premium&due=30` does not match plain `?segment=premium`.
  for (const [key, value] of wanted) {
    if (params.get(key) !== value) {
      return 0;
    }
  }

  // An item that names no parameters must not win a page that has one, or
  // "Directory" would stay lit while you are on "Premium Users". The
  // exception is a path that is genuinely deeper, like an article's editor.
  const named = [...wanted].length;

  if (named === 0 && itemPath === path && [...params].some(([k]) => k === "segment")) {
    return 0;
  }

  return itemPath.length + named * 1000;
}

export function Rail({ brands }: { brands: number }) {
  const path = usePathname();
  const params = useSearchParams();

  const current = NAV.flatMap((group) => group.items)
    .filter((item) => item.built)
    .map((item) => ({ item, points: score(item.href, path, params) }))
    .filter((match) => match.points > 0)
    .sort((a, b) => b.points - a.points)[0]?.item.href;

  return (
    <nav className="rail" aria-label="Admin">
      <div className="rail-head">
        <strong>Petrosil</strong>
        <span>
          {brands} brand{brands === 1 ? "" : "s"} · {BUILT} of {TOTAL} screens
        </span>
      </div>

      {NAV.map((group) => (
        <div key={group.group}>
          <div className="rail-group">{group.group}</div>
          {group.items.map((item) =>
            item.built ? (
              <Link
                key={item.href}
                href={item.href}
                className={item.href === current ? "on" : undefined}
              >
                {item.label}
              </Link>
            ) : (
              <span key={item.href} className="soon" title="Not built yet">
                {item.label}
                <span className="badge">soon</span>
              </span>
            ),
          )}
        </div>
      ))}
    </nav>
  );
}
