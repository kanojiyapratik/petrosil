/**
 * Who is calling, and for which brand.
 *
 * The module authenticates with a bearer token, one per site, exactly as it
 * does against the Laravel sites today. Two things differ, deliberately:
 *
 *  - only a SHA-256 of the token is stored. The Laravel sites kept
 *    `users.api_token` in clear text, and one copy leaked through a seed file.
 *  - the token names the site, and the slug in the URL must agree with it. A
 *    valid token for one brand cannot read another brand's data even if the
 *    path says otherwise — the console once had an id-only cross-site bug and
 *    this is where that class of bug would come back.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { siteApiTokens, sites } from "@/db/schema";

export type Caller = {
  site: typeof sites.$inferSelect;
  tokenId: number;
};

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 404,
  ) {
    super(message);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  return match ? match[1]!.trim() : null;
}

/**
 * @throws AuthError when the token is missing, unknown, revoked, or belongs to
 *         a different brand than the one in the URL.
 */
export async function authenticate(
  request: Request,
  slug: string,
  database: Database = db(),
): Promise<Caller> {
  const token = bearerFrom(request);

  if (!token) {
    throw new AuthError("This endpoint needs a bearer token.", 401);
  }

  const [row] = await database
    .select({ token: siteApiTokens, site: sites })
    .from(siteApiTokens)
    .innerJoin(sites, eq(sites.id, siteApiTokens.siteId))
    .where(and(eq(siteApiTokens.tokenHash, hashToken(token)), isNull(siteApiTokens.revokedAt)))
    .limit(1);

  if (!row) {
    throw new AuthError("That token is not valid.", 401);
  }

  // The lookup above is already a constant-time-irrelevant hash comparison in
  // the database; this second check guards the slug, where a mismatch is a
  // routing or configuration error worth naming separately from a bad token.
  if (!sameString(row.site.slug, slug)) {
    throw new AuthError("That token does not belong to this site.", 403);
  }

  // Not awaited: a failed bookkeeping write must never fail the call it is
  // recording. Errors are swallowed on purpose.
  void database
    .update(siteApiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(siteApiTokens.id, row.token.id))
    .catch(() => {});

  return { site: row.site, tokenId: row.token.id };
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/** The caller's IP as the proxy reports it, for the audit trail. */
export function callerIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    return forwarded.split(",")[0]!.trim();
  }

  return request.headers.get("x-real-ip");
}
