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
import { sites, users } from "@/db/schema";
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

/** Headers a CDN in front of the app may set with the visitor's two-letter country. */
const GEO_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "x-country-code"];

/**
 * Where the reader is, for choosing a currency: a signed-in reader's profile
 * country; otherwise the CDN's geo header when there is one; otherwise what
 * the page passes as `?country=`, or the browser time zone it passes as
 * `?tz=`. Null when nothing says — which prices in
 * dollars. It only decides what is shown: the checkout charges by the
 * buyer's profile country either way.
 */
export async function visitorCountry(request: Request, url: URL, viewer: Viewer): Promise<string | null> {
  if (viewer.userId !== null) {
    const [person] = await db().select({ country: users.country }).from(users).where(eq(users.id, viewer.userId)).limit(1);

    if (person?.country?.trim()) {
      return person.country.trim();
    }
  }

  for (const name of GEO_HEADERS) {
    const code = request.headers.get(name)?.trim();

    // Cloudflare sends XX for unknown and T1 for Tor.
    if (code && /^[a-z]{2}$/i.test(code) && !/^(xx|t1)$/i.test(code)) {
      return code.toUpperCase();
    }
  }

  const asked = url.searchParams.get("country")?.trim();

  if (asked) {
    return asked.slice(0, 64);
  }

  return SUBCONTINENT_ZONES[url.searchParams.get("tz")?.trim() ?? ""] ?? null;
}

/**
 * The browser's time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`),
 * which a page can always send when no CDN tells us the country. Only the
 * subcontinent's zones are named — including the old spellings browsers still
 * report — since anywhere else prices in dollars anyway.
 */
const SUBCONTINENT_ZONES: Record<string, string> = {
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Kathmandu": "NP",
  "Asia/Katmandu": "NP",
  "Asia/Dhaka": "BD",
  "Asia/Dacca": "BD",
  "Asia/Karachi": "PK",
  "Asia/Colombo": "LK",
  "Asia/Thimphu": "BT",
  "Asia/Thimbu": "BT",
  "Indian/Maldives": "MV",
  "Asia/Kabul": "AF",
};
