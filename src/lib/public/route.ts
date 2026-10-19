/**
 * The plumbing every brand-site endpoint shares: find the brand, work out who
 * is reading, decide what they are entitled to, run.
 *
 * It mirrors `compat()` and `dashboard()` deliberately — three wrappers with
 * the same shape are easier to hold in your head than one wrapper with three
 * modes. The difference is that this one does not refuse an anonymous caller:
 * the brand sites are public, and the paywall is applied to the figures
 * rather than to the page.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sites } from "@/db/schema";
import { identify } from "@/lib/auth/session";
import { tokenFrom } from "@/lib/auth/guard";
import { entitlementFor, type Entitlement, type Viewer } from "@/domain/public/paywall";
import { today } from "@/domain/price/dates";

export type Brand = typeof sites.$inferSelect;

export type PublicArgs = {
  request: Request;
  url: URL;
  brand: Brand;
  viewer: Viewer;
  entitlement: Entitlement;
  params: Record<string, string>;
};

export const noSuchBrand = () => NextResponse.json({ message: "No such brand." }, { status: 404 });

/**
 * A brand nobody signed in reads as a brand nobody is entitled to — the same
 * code path as a free reader, so there is no "anonymous" branch anywhere
 * downstream to forget about.
 */
export async function viewerFor(request: Request): Promise<Viewer> {
  const identity = await identify(tokenFrom(request));

  if (!identity) {
    return { userId: null, memberships: [] };
  }

  return {
    userId: identity.user.id,
    memberships: identity.memberships.map((m) => ({
      siteId: m.siteId,
      role: m.role,
      tier: m.tier,
      expiresAt: m.expiresAt,
    })),
  };
}

export function publicApi(
  handler: (args: PublicArgs) => Promise<NextResponse> | NextResponse,
  options: { brandless?: boolean } = {},
) {
  return async function route(
    request: Request,
    context?: { params?: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    const params = (await context?.params) ?? {};

    try {
      const viewer = await viewerFor(request);
      const url = new URL(request.url);

      // The estate list has no brand of its own; everything else refuses to
      // run until the slug in the path resolves to a live brand.
      if (options.brandless) {
        const blank = { id: 0 } as Brand;

        return await handler({
          request,
          url,
          brand: blank,
          viewer,
          entitlement: entitlementFor(viewer, 0, today()),
          params,
        });
      }

      const [brand] = await db()
        .select()
        .from(sites)
        .where(and(eq(sites.slug, String(params.site ?? "")), eq(sites.enabled, true)))
        .limit(1);

      // A disabled brand answers exactly like one that never existed. A
      // different reply would confirm which slugs are real while a site is
      // being prepared.
      if (!brand) {
        return noSuchBrand();
      }

      return await handler({
        request,
        url,
        brand,
        viewer,
        entitlement: entitlementFor(viewer, brand.id, today()),
        params,
      });
    } catch (error) {
      console.error("public endpoint failed", { path: new URL(request.url).pathname, error });

      return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
    }
  };
}

/** A positive integer path segment, or null. */
export function idFrom(params: Record<string, string>): number | null {
  const id = Number(params.id);

  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * A bounded integer out of the query string.
 *
 * The absent case is checked before the number, because `Number(null)` is 0
 * and `Number("")` is 0 — both finite. Reading the fallback off `Number.isFinite`
 * alone silently clamped every list to a single row.
 */
export function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);

  if (raw === null || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(1, Math.trunc(value)));
}
