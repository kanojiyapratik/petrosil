/**
 * One answer to "which brands may this query read".
 *
 * Every list screen needs it and every one of them would otherwise reach for
 * the slug on the request. A slug the viewer cannot see narrows to nothing
 * (`[-1]` matches no row) rather than widening to everything, which is the
 * failure mode the old console shipped: an id alone decided what came back,
 * and one brand's staff could pull another brand's rows.
 */

import { eq } from "drizzle-orm";

import { db, type Database } from "@/db";
import { sites } from "@/db/schema";

/** `undefined` means "no narrowing needed" — a superadmin with no filter. */
export async function siteScope(
  siteIds: number[],
  slug: string | undefined,
  database: Database = db(),
): Promise<number[] | undefined> {
  if (!slug) {
    return siteIds.length > 0 ? siteIds : undefined;
  }

  const [site] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!site || (siteIds.length > 0 && !siteIds.includes(site.id))) {
    return [-1];
  }

  return [site.id];
}

/** Today, as the estate writes it. Passed in by tests, never guessed. */
export function isoDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type Paged<T> = { rows: T[]; total: number; page: number; per_page: number };

export function paging(query: { page?: number; perPage?: number }, fallback = 25) {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const perPage = Math.min(200, Math.max(1, Math.trunc(query.perPage ?? fallback)));

  return { page, perPage, offset: (page - 1) * perPage };
}
