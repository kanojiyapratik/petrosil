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
import { SubTabs } from "../../../subtabs";

export function SiteTabs({ slug, name }: { slug: string; name: string }) {
  const path = usePathname();
  const tabs = siteTabs(slug);

  // A tab owns every screen in it, not only the one it lands on: Offers is
  // Content's as much as Articles is. The deepest matching screen wins, and
  // the brand's dashboard — a prefix of everything — only on an exact match.
  const within = (href: string) => path === href || path.startsWith(`${href}/`);
  const best = tabs
    .flatMap((tab) => tab.items.filter((item) => within(item.href)).map((item) => ({ tab, length: item.href.length })))
    .sort((a, b) => b.length - a.length)[0];
  const open = best?.tab ?? tabs[0];

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

      <SubTabs items={open!.items.filter((item) => item.built)} label={`${open!.label} screens`} />
    </>
  );
}
