/**
 * A live brand by its slug, for endpoints that run under `account()` rather
 * than `publicApi()`. A disabled brand answers as one that does not exist.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sites } from "@/db/schema";
import { AccountError } from "@/domain/accounts/register";

export async function liveBrand(slug: string): Promise<typeof sites.$inferSelect> {
  const [brand] = await db()
    .select()
    .from(sites)
    .where(and(eq(sites.slug, slug), eq(sites.enabled, true)))
    .limit(1);

  if (!brand) {
    throw new AccountError("No such brand.", 404);
  }

  return brand;
}
