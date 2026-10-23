"use client";

/**
 * A brand's sections.
 *
 * A client component for the same single reason the rail is one: only the
 * browser knows which screen is open, and this strip has to say so.
 *
 * It highlights by the deepest matching path, so `…/settings/directory`
 * lights Settings rather than nothing, and the brand's own dashboard — whose
 * path is a prefix of every other — only wins on an exact match.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { siteTabs } from "../../../nav";

export function SiteTabs({ slug, name }: { slug: string; name: string }) {
  const path = usePathname();
  const tabs = siteTabs(slug);

  const open =
    tabs
      .filter((tab) => path === tab.href || path.startsWith(`${tab.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0] ?? tabs[0];

  return (
    <>
      <h1 className="brandhead">{name}</h1>

      <nav className="pagetabs" aria-label={`${name} sections`}>
        {tabs.map((tab) => (
          <Link
            key={tab.slug}
            href={tab.href}
            className={tab === open ? "on" : undefined}
            aria-current={tab === open ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
