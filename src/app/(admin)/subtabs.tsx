"use client";

/**
 * The screens inside a section, as a second row under its tabs.
 *
 * Without it a tab was a door to its first screen and nothing else: Content
 * landed on Articles, and Reports, Offers, Announcements and Files had no
 * link anywhere in the admin. A section's screens are siblings, so they are
 * shown side by side, and the deepest matching path lights up — so a
 * report's own page still lights Reports, and Mail beats General under
 * Settings.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

export type SubTab = { label: string; href: string };

export function SubTabs({ items, label }: { items: readonly SubTab[]; label: string }) {
  const path = usePathname();

  if (items.length < 2) {
    return null;
  }

  const within = (href: string) => path === href || path.startsWith(`${href}/`);
  const open = items.filter((item) => within(item.href)).sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <nav className="subtabs" aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={item === open ? "on" : undefined}
          aria-current={item === open ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
