/**
 * Who is reading a brand page, and what they may see — the page-side twin of
 * `viewerFor` + `entitlementFor` in `route.ts`, so a page and the API can
 * never disagree about a figure.
 */

import { cache } from "react";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sites } from "@/db/schema";
import { currentIdentity } from "@/lib/auth/server";
import { entitlementFor, type Entitlement, type Viewer } from "@/domain/public/paywall";
import { today } from "@/domain/price/dates";

export type Brand = typeof sites.$inferSelect;

export type Reader = {
  /** Null for a visitor nobody signed in. */
  name: string | null;
  country: string | null;
  viewer: Viewer;
  entitlement: Entitlement;
};

/** A live brand by slug, or null: a disabled brand answers like one that never existed. */
export const liveBrandBySlug = cache(async (slug: string): Promise<Brand | null> => {
  const [brand] = await db()
    .select()
    .from(sites)
    .where(and(eq(sites.slug, slug), eq(sites.enabled, true)))
    .limit(1);

  return brand ?? null;
});

export const readerFor = cache(async (siteId: number): Promise<Reader> => {
  const identity = await currentIdentity();

  const viewer: Viewer = identity
    ? {
        userId: identity.user.id,
        memberships: identity.memberships.map((m) => ({
          siteId: m.siteId,
          role: m.role,
          tier: m.tier,
          expiresAt: m.expiresAt,
        })),
      }
    : { userId: null, memberships: [] };

  return {
    name: identity?.user.name ?? null,
    country: identity?.user.country ?? null,
    viewer,
    entitlement: entitlementFor(viewer, siteId, today()),
  };
});
