"use client";

/**
 * The brand filter in the admin header.
 *
 * A client component because it has to know which screen is open:
 *
 * - On a brand's own page (`/dashboard/sites/<slug>/...`) the page already
 *   names its brand, so the filter shows that brand and changing it moves to
 *   the same tab of the other brand. Choosing "All brands" there goes to the
 *   Dashboard, since a brand page has no all-brands version.
 * - On the screens every brand shares (Global settings, Currencies, Roles)
 *   it still works, but says that this screen covers every brand.
 * - Everywhere else it narrows what the screen shows.
 *
 * Either way the choice is kept, so it is still chosen on the next screen.
 */

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

import { chooseBrand } from "./actions";

type Option = { slug: string; name: string };

/** Screens that are the same for every brand, so the filter cannot narrow them. */
const SHARED = ["/dashboard/global", "/dashboard/currencies", "/dashboard/roles"];

/** Under a shared prefix, but a report of what each brand did, so it can be narrowed. */
const NARROWABLE = ["/dashboard/global/ai-providers/usage"];

function brandPage(path: string): { slug: string; rest: string } | null {
  const match = /^\/dashboard\/sites\/([^/]+)(\/.*)?$/.exec(path);

  return match ? { slug: match[1]!, rest: match[2] ?? "" } : null;
}

export function BrandSwitch({ brands, chosen }: { brands: Option[]; chosen: string | null }) {
  const path = usePathname();
  const router = useRouter();
  const [busy, start] = useTransition();

  if (brands.length < 2) {
    return null;
  }

  const page = brandPage(path);
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
  const shared = SHARED.some(under) && !NARROWABLE.some(under);
  const value = page?.slug ?? chosen ?? "";

  function change(slug: string) {
    start(async () => {
      await chooseBrand(slug);

      if (page) {
        // The same tab of the other brand. A record's id under a tab belongs
        // to the brand it came from, so only the tab itself is kept.
        const tab = page.rest.split("/")[1];
        router.push(slug ? `/dashboard/sites/${slug}${tab ? `/${tab}` : ""}` : "/dashboard");
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className={value ? "brand-switch on" : "brand-switch"}>
      <label htmlFor="brand-switch">Brand</label>
      <select id="brand-switch" value={value} disabled={busy} onChange={(event) => change(event.target.value)}>
        <option value="">All brands</option>
        {brands.map((brand) => (
          <option key={brand.slug} value={brand.slug}>
            {brand.name}
          </option>
        ))}
      </select>
      {shared ? <span className="brand-switch-note">This screen covers every brand</span> : null}
    </div>
  );
}
