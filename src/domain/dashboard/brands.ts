/**
 * The brands a viewer may pick from.
 *
 * Every admin list screen has a brand filter, and each one needs the same
 * short answer: which brands is this person allowed to narrow to, and what
 * are they called. `estateOverview` could tell you, but it counts prices,
 * people and batches to do it — far too much work for a `<select>`.
 */

import { asc, inArray } from "drizzle-orm";

import { db, type Database } from "@/db";
import { sites } from "@/db/schema";

export type Brand = { id: number; slug: string; name: string };

/** Empty `siteIds` means superadmin: every brand. */
export async function brandsFor(siteIds: number[], database: Database = db()): Promise<Brand[]> {
  return database
    .select({ id: sites.id, slug: sites.slug, name: sites.name })
    .from(sites)
    .where(siteIds.length > 0 ? inArray(sites.id, siteIds) : undefined)
    .orderBy(asc(sites.slug));
}
