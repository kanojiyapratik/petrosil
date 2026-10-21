"use client";

/**
 * The left rail. A client component only because it needs to know which
 * screen is open, which is the one thing the server cannot tell it on a
 * shared layout.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { BUILT, NAV, TOTAL } from "./nav";

export function Rail({ brands }: { brands: number }) {
  const path = usePathname();

  // Longest match, so /dashboard/locations does not also light up
  // /dashboard. The old admin did this with request()->segment(2).
  const current = NAV.flatMap((group) => group.items)
    .filter((item) => item.built && (path === item.href || path.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

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
