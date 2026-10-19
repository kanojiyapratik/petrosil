/**
 * Who may see what.
 *
 * Three roles, from the console's own grant model: `superadmin` sees the
 * whole estate, `staff` only the brands they were granted, `subscriber` is a
 * reader and has no dashboard at all.
 *
 * The important part is `visibleSites()`. Every dashboard query goes through
 * it rather than reading a slug off the request: the old console shipped a
 * bug where an id alone decided what was returned, and one brand's staff
 * could pull another brand's row. Here there is one place that answers "which
 * brands is this person allowed to see", and it is never the URL.
 */

import { NextResponse } from "next/server";

import { identify, type Identity } from "./session";
import { COOKIE } from "./session";
import { AccountError } from "@/domain/accounts/register";

export type Guarded = { identity: Identity; siteIds: number[]; isSuperadmin: boolean };

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

export function tokenFrom(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === COOKIE) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

export function isSuperadmin(identity: Identity): boolean {
  return identity.memberships.some((membership) => membership.role === "superadmin");
}

/** The brands this person may read. Empty means "no dashboard for you". */
export function visibleSites(identity: Identity): number[] {
  if (isSuperadmin(identity)) {
    return [];
  }

  return identity.memberships
    .filter((membership) => membership.role === "staff")
    .map((membership) => membership.siteId);
}

/**
 * @throws AccessError 401 when nobody is signed in, 403 when the person is a
 *         reader rather than a member of the team.
 */
export async function requireTeam(request: Request): Promise<Guarded> {
  const identity = await identify(tokenFrom(request));

  if (!identity) {
    throw new AccessError("Sign in to continue.", 401);
  }

  const superadmin = isSuperadmin(identity);
  const siteIds = visibleSites(identity);

  if (!superadmin && siteIds.length === 0) {
    throw new AccessError("This area is for Petrosil staff.", 403);
  }

  return { identity, siteIds, isSuperadmin: superadmin };
}

/** Narrow a request to one brand, refusing a brand this person cannot see. */
export function requireSiteAccess(guard: Guarded, siteId: number): void {
  if (!guard.isSuperadmin && !guard.siteIds.includes(siteId)) {
    throw new AccessError("You do not have access to that brand.", 403);
  }
}

/** The wrapper every dashboard route uses, mirroring the compat one. */
export function dashboard(
  handler: (args: { request: Request; guard: Guarded; params: Record<string, string> }) => Promise<NextResponse> | NextResponse,
) {
  return async function route(
    request: Request,
    context?: { params?: Promise<Record<string, string>> },
  ): Promise<NextResponse> {
    const params = (await context?.params) ?? {};

    try {
      return await handler({ request, guard: await requireTeam(request), params });
    } catch (error) {
      if (error instanceof AccessError) {
        return NextResponse.json({ message: error.message }, { status: error.status });
      }

      // Billing and account rules are raised as AccountError from the domain,
      // and some of them (a trial already decided, for instance) surface on
      // dashboard endpoints too.
      if (error instanceof AccountError) {
        return NextResponse.json(
          error.field
            ? { message: error.message, errors: { [error.field]: [error.message] } }
            : { message: error.message },
          { status: error.status },
        );
      }

      console.error("dashboard endpoint failed", {
        path: new URL(request.url).pathname,
        error,
      });

      return NextResponse.json({ message: "Something went wrong." }, { status: 500 });
    }
  };
}
