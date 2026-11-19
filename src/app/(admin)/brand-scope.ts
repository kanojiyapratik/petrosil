/**
 * The header's brand filter: which brand the estate-wide screens are showing.
 *
 * Before it, Customers, Payments, Plans and Activity each had their own row
 * of brand chips, and Dashboard, People, Sign-ins, Trials, Coupons and Staff
 * had none at all, so "which brand am I looking at" got a different answer
 * on every screen. Now one choice in the header narrows them all, and it
 * stays chosen as you move between screens (a cookie, not a URL parameter,
 * so the rail's links stay plain).
 *
 * It narrows **reads only**. `viewer.siteIds` is also what decides who may
 * save what, and what the rail lists. A superadmin filtering to one brand is
 * still a superadmin: they can still edit an every-brand coupon, and the
 * rail still lists all nine brands. So screens pass `scope.siteIds` to the
 * queries that fill their lists, and keep `viewer.siteIds` for everything
 * else.
 */

import { cookies } from "next/headers";

import type { Viewer } from "@/lib/auth/server";
import { brandsFor, type Brand } from "@/domain/dashboard/brands";

export const BRAND_COOKIE = "admin_brand";

export type BrandScope = {
  /** The brand chosen in the header, or null for all brands. */
  brand: Brand | null;
  /** Every brand the viewer may choose from. */
  brands: Brand[];
  /** What list queries should read: the chosen brand, or what the viewer may see. */
  siteIds: number[];
};

/**
 * The rule, kept apart so it can be tested without a request.
 *
 * A slug the viewer may not see, or one that no longer exists, counts as no
 * choice at all, not as an empty screen. The cookie outlives grants: staff
 * who lose a brand should land on their other brands, not on nothing.
 */
export function narrowTo(viewerSiteIds: number[], brands: Brand[], slug: string | undefined): BrandScope {
  const brand = slug ? brands.find((row) => row.slug === slug) ?? null : null;

  return { brand, brands, siteIds: brand ? [brand.id] : viewerSiteIds };
}

export async function brandScope(viewer: Viewer): Promise<BrandScope> {
  const [jar, brands] = await Promise.all([cookies(), brandsFor(viewer.siteIds)]);

  return narrowTo(viewer.siteIds, brands, jar.get(BRAND_COOKIE)?.value);
}
