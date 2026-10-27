/**
 * The categories a brand files its articles under.
 *
 * The slug is made once from the name and never moves: it is in the address
 * of every category page the brand site has published. A category can only
 * be deleted when nothing is filed under it; the old admin deleted it anyway
 * and left its articles filed under a number that no longer existed.
 */

import { and, count, eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { articleCategories, articles, auditLog, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";

export type CategoryInput = {
  id?: number;
  /** The brand, on a new category only. */
  site?: string;
  name: unknown;
  sort_order?: unknown;
};

export type CategorySaved = { id: number; slug: string; name: string; sort_order: number };

async function slugFor(siteId: number, name: string, database: Database): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "category";

  const taken = await database
    .select({ slug: articleCategories.slug })
    .from(articleCategories)
    .where(and(eq(articleCategories.siteId, siteId), sql`${articleCategories.slug} like ${`${base}%`}`));

  const used = new Set(taken.map((row) => row.slug));

  if (!used.has(base)) {
    return base;
  }

  for (let n = 2; n < 1000; n += 1) {
    if (!used.has(`${base}-${n}`)) {
      return `${base}-${n}`;
    }
  }

  return `${base}-${Date.now()}`;
}

/** Null when it is another brand's category. */
export async function saveCategory(
  guard: Guarded,
  input: CategoryInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<CategorySaved | null> {
  let existing: typeof articleCategories.$inferSelect | undefined;
  let siteId: number;

  if (input.id !== undefined) {
    [existing] = await database.select().from(articleCategories).where(eq(articleCategories.id, input.id)).limit(1);

    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      return null;
    }

    siteId = existing.siteId;
    await requirePermission(guard, siteId, "category-edit", database);
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("We do not recognise that brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
    await requirePermission(guard, siteId, "category-create", database);
  }

  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 191);

  if (name === "") {
    throw new AccountError("Give the category a name.", 422, "name");
  }

  const sortOrder = Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : (existing?.sortOrder ?? 0);

  const [row] = existing
    ? await database
        .update(articleCategories)
        .set({ name, sortOrder })
        .where(eq(articleCategories.id, existing.id))
        .returning()
    : await database
        .insert(articleCategories)
        .values({ siteId, name, sortOrder, slug: await slugFor(siteId, name, database) })
        .returning();

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "category.update" : "category.create",
    entity: "article_category",
    entityId: row!.id,
    detail: existing ? { was: existing.name, now: name } : { name, slug: row!.slug },
    ip: context.ip ?? null,
  });

  return { id: row!.id, slug: row!.slug, name: row!.name, sort_order: row!.sortOrder };
}

/** False when it is another brand's; refused while articles are filed under it. */
export async function deleteCategory(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const [found] = await database.select().from(articleCategories).where(eq(articleCategories.id, id)).limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return false;
  }

  await requirePermission(guard, found.siteId, "category-delete", database);

  // Withdrawn articles count too: they are still rows that would point at nothing.
  const [filed] = await database.select({ n: count() }).from(articles).where(eq(articles.categoryId, id));

  if ((filed?.n ?? 0) > 0) {
    throw new AccountError(
      `${filed!.n} article${filed!.n === 1 ? " is" : "s are"} filed under "${found.name}". Move ${filed!.n === 1 ? "it" : "them"} first.`,
      409,
    );
  }

  await database.delete(articleCategories).where(eq(articleCategories.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "category.delete",
    entity: "article_category",
    entityId: id,
    detail: { name: found.name, slug: found.slug },
    ip: context.ip ?? null,
  });

  return true;
}
