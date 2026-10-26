/**
 * Articles: the public list, one piece, and the screens staff write from.
 *
 * Two rules, both of which the old estate broke.
 *
 * A draft is not reachable from the public side. `articles/{id}` read by id
 * with no status check, so an unpublished piece was one guessed number away,
 * and a piece dated for next week was already live. Publication here means
 * status `published` AND a `published_at` that has passed.
 *
 * A locked piece keeps its body out of the reply, not merely off the screen.
 * The old article page rendered the whole thing and hid the overflow with
 * CSS, which is a paywall anyone can read around with developer tools.
 */

import { and, count, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { articleCategories, articles, auditLog, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { requirePermission } from "@/domain/staff/permissions";
import { AccountError } from "@/domain/accounts/register";

export type ArticleCard = {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  hero_image: string | null;
  category: string | null;
  premium_only: boolean;
  /** Carried on every card: a staff list that cannot show a draft is useless. */
  status: string;
  published_at: string | null;
  views: number;
};

export type ArticleFull = ArticleCard & { body: string | null };

const card = (
  row: typeof articles.$inferSelect,
  category: string | null,
): ArticleCard => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  excerpt: row.excerpt,
  hero_image: row.heroImage,
  category,
  premium_only: row.premiumOnly,
  status: row.status,
  published_at: row.publishedAt?.toISOString() ?? null,
  views: row.views,
});

/** `published`, and not dated for later. Used by every public query. */
const live = () =>
  and(
    eq(articles.status, "published"),
    isNull(articles.deletedAt),
    isNotNull(articles.publishedAt),
    lte(articles.publishedAt, sql`now()`),
  );

export async function publishedArticles(
  siteId: number,
  options: { category?: string; search?: string; limit?: number; offset?: number } = {},
  database: Database = db(),
): Promise<{ articles: ArticleCard[]; total: number }> {
  const where = and(
    eq(articles.siteId, siteId),
    live(),
    options.category
      ? eq(
          articles.categoryId,
          database
            .select({ id: articleCategories.id })
            .from(articleCategories)
            .where(
              and(
                eq(articleCategories.siteId, siteId),
                eq(articleCategories.slug, options.category),
              ),
            ),
        )
      : undefined,
    options.search ? sql`${articles.title} ilike ${`%${options.search}%`}` : undefined,
  );

  const [counted] = await database.select({ n: count() }).from(articles).where(where);

  // The body is never selected for a list. There are 119,000 articles across
  // the estate and the longest are tens of kilobytes.
  const rows = await database
    .select({
      article: articles,
      category: articleCategories.slug,
    })
    .from(articles)
    .leftJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .where(where)
    .orderBy(desc(articles.publishedAt), desc(articles.id))
    .limit(Math.min(100, Math.max(1, options.limit ?? 20)))
    .offset(Math.max(0, options.offset ?? 0));

  return {
    articles: rows.map((row) => card(row.article, row.category)),
    total: counted?.n ?? 0,
  };
}

/**
 * One article by slug. Null when there is nothing a reader may see, which the
 * route answers as 404 — a draft and a slug that was never used answer the
 * same way, so guessing tells nobody anything.
 */
export async function publishedArticle(
  siteId: number,
  slug: string,
  entitled: boolean,
  database: Database = db(),
): Promise<{ article: ArticleFull; locked: boolean } | null> {
  const [row] = await database
    .select({ article: articles, category: articleCategories.slug })
    .from(articles)
    .leftJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .where(and(eq(articles.siteId, siteId), eq(articles.slug, slug), live()))
    .limit(1);

  if (!row) {
    return null;
  }

  const locked = row.article.premiumOnly && !entitled;

  // Awaited, but never allowed to fail the read it counts. Fire-and-forget
  // would be cheaper and would also lose counts — the write can land after
  // the response, or not at all — and this number is what the editorial
  // screens rank by.
  try {
    await database
      .update(articles)
      .set({ views: sql`${articles.views} + 1` })
      .where(eq(articles.id, row.article.id));
  } catch (error) {
    console.error("could not count an article read", { id: row.article.id, error });
  }

  return {
    article: {
      ...card(row.article, row.category),
      // The excerpt stays either way: it is the hook, and the reason to
      // subscribe is being able to read the rest.
      body: locked ? null : row.article.body,
    },
    locked,
  };
}

/* ----------------------------------------------------------- staff screens */

export async function staffArticles(
  siteIds: number[],
  options: { site?: string; status?: string; search?: string; limit?: number } = {},
  database: Database = db(),
): Promise<ArticleCard[]> {
  const rows = await database
    .select({ article: articles, category: articleCategories.slug, slug: sites.slug })
    .from(articles)
    .innerJoin(sites, eq(sites.id, articles.siteId))
    .leftJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .where(
      and(
        // Empty means superadmin: the whole estate.
        siteIds.length > 0 ? inArray(articles.siteId, siteIds) : undefined,
        isNull(articles.deletedAt),
        options.site ? eq(sites.slug, options.site) : undefined,
        options.status ? eq(articles.status, options.status) : undefined,
        options.search ? sql`${articles.title} ilike ${`%${options.search}%`}` : undefined,
      ),
    )
    .orderBy(desc(articles.updatedAt), desc(articles.id))
    .limit(Math.min(200, Math.max(1, options.limit ?? 50)));

  return rows.map((row) => card(row.article, row.category));
}

/**
 * A slug from a title, made unique within the brand.
 *
 * The suffix counts up rather than appending a random string: "base-oil-
 * holds-firm-2" is something an editor can read in a URL and recognise.
 */
export async function slugFor(
  siteId: number,
  title: string,
  database: Database = db(),
): Promise<string> {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 180) || "article";

  const taken = await database
    .select({ slug: articles.slug })
    .from(articles)
    .where(and(eq(articles.siteId, siteId), sql`${articles.slug} like ${`${base}%`}`));

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

export async function createArticle(
  guard: Guarded,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<ArticleCard> {
  const [brand] = await database
    .select()
    .from(sites)
    .where(eq(sites.slug, String(body.site ?? "")))
    .limit(1);

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 422, "site");
  }

  // Writing is scoped exactly like reading: the brand comes from the body
  // here, so it has to be checked against the grant, not trusted.
  if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, "article-create", database);

  const title = String(body.title ?? "").trim().replace(/\s+/g, " ");

  if (title.length === 0) {
    throw new AccountError("Give the piece a title.", 422, "title");
  }

  const [row] = await database
    .insert(articles)
    .values({
      siteId: brand.id,
      slug: await slugFor(brand.id, title, database),
      title: title.slice(0, 255),
      excerpt: typeof body.excerpt === "string" ? body.excerpt.slice(0, 2000) : null,
      body: typeof body.body === "string" ? body.body : "",
      heroImage: typeof body.hero_image === "string" ? body.hero_image.slice(0, 512) : null,
      premiumOnly: body.premium_only === true,
      categoryId: await categoryFor(brand.id, body.category_id, database),
      authorId: guard.identity.user.id,
      // Always a draft. Publishing is its own, audited act.
      status: "draft",
    })
    .returning();

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "article.create",
    entity: "article",
    entityId: row!.id,
    detail: { title: row!.title, slug: row!.slug },
    ip: context.ip ?? null,
  });

  return card(row!, null);
}

/**
 * The category an article is filed under, checked against the brand.
 *
 * It arrives as a number from a form and was used as it came, so baseoil's
 * article could be filed under one of bitumart's categories. An id alone
 * deciding what happens is the shape of bug this codebase keeps finding in
 * the old console, and the join would then show one brand's category on
 * another brand's article.
 *
 * `undefined` means "not being changed"; null means "file it under nothing".
 */
async function categoryFor(
  siteId: number,
  given: unknown,
  database: Database,
): Promise<number | null> {
  if (typeof given !== "number") {
    return null;
  }

  const [found] = await database
    .select({ id: articleCategories.id })
    .from(articleCategories)
    .where(and(eq(articleCategories.id, given), eq(articleCategories.siteId, siteId)))
    .limit(1);

  if (!found) {
    throw new AccountError(
      "That category belongs to a different brand.",
      422,
      "category_id",
    );
  }

  return found.id;
}

const EDITABLE_TEXT = { excerpt: 2000, body: 1_000_000, hero_image: 512 } as const;

export async function updateArticle(
  guard: Guarded,
  id: number,
  body: Record<string, unknown>,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<ArticleCard | null> {
  const [found] = await database
    .select()
    .from(articles)
    .where(and(eq(articles.id, id), isNull(articles.deletedAt)))
    .limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return null;
  }

  await requirePermission(guard, found.siteId, "article-edit", database);

  const changes: Partial<typeof articles.$inferInsert> = { updatedAt: new Date() };

  if (body.title !== undefined) {
    const title = String(body.title).trim().replace(/\s+/g, " ");

    if (title.length === 0) {
      throw new AccountError("Give the piece a title.", 422, "title");
    }

    changes.title = title.slice(0, 255);
  }

  if (body.excerpt !== undefined) {
    changes.excerpt =
      typeof body.excerpt === "string" ? body.excerpt.slice(0, EDITABLE_TEXT.excerpt) : null;
  }

  if (typeof body.body === "string") {
    changes.body = body.body;
  }

  if (body.hero_image !== undefined) {
    changes.heroImage =
      typeof body.hero_image === "string" ? body.hero_image.slice(0, 512) : null;
  }

  if (typeof body.premium_only === "boolean") {
    changes.premiumOnly = body.premium_only;
  }

  if (body.category_id !== undefined) {
    changes.categoryId = await categoryFor(found.siteId, body.category_id, database);
  }

  let published = false;

  if (body.status === "draft" || body.status === "published") {
    changes.status = body.status;

    // Stamped once. Correcting a typo on a piece that is already out must not
    // re-date it to the top of the list.
    if (body.status === "published" && found.publishedAt === null) {
      changes.publishedAt = new Date();
      published = true;
    }

    published = published || (body.status === "published" && found.status !== "published");
  }

  await database.update(articles).set(changes).where(eq(articles.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: published ? "article.publish" : "article.update",
    entity: "article",
    entityId: id,
    detail: { fields: Object.keys(changes).filter((key) => key !== "updatedAt") },
    ip: context.ip ?? null,
  });

  const [after] = await database.select().from(articles).where(eq(articles.id, id)).limit(1);

  return card(after!, null);
}

/**
 * Withdraw, not destroy. Twenty years of writing is not something an endpoint
 * should be able to erase, and the row is still the target of every link ever
 * shared to it.
 */
export async function withdrawArticle(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const [found] = await database
    .select()
    .from(articles)
    .where(and(eq(articles.id, id), isNull(articles.deletedAt)))
    .limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return false;
  }

  await requirePermission(guard, found.siteId, "article-delete", database);

  await database
    .update(articles)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(articles.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "article.withdraw",
    entity: "article",
    entityId: id,
    detail: { title: found.title, slug: found.slug },
    ip: context.ip ?? null,
  });

  return true;
}

export type ArticleForEdit = ArticleFull & {
  site: string;
  site_name: string;
  category_id: number | null;
  updated_at: string;
};

/**
 * One article, as its editor needs it.
 *
 * `publishedArticle` is the reader's route and cannot serve this: it refuses
 * anything not published, strips the body behind the paywall, and counts a
 * view. An editor opening their own draft would be turned away, and opening
 * a published piece to fix a typo would inflate the number the editorial
 * screens rank by.
 *
 * Scoped like every other dashboard read: another brand's article answers
 * the same as no such article, so an id cannot be used to find out what a
 * brand you cannot see has written.
 */
export async function articleForEdit(
  siteIds: number[],
  id: number,
  database: Database = db(),
): Promise<ArticleForEdit | null> {
  const [row] = await database
    .select({ article: articles, category: articleCategories.slug, slug: sites.slug, name: sites.name })
    .from(articles)
    .innerJoin(sites, eq(sites.id, articles.siteId))
    .leftJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .where(and(eq(articles.id, id), isNull(articles.deletedAt)))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.article.siteId))) {
    return null;
  }

  return {
    ...card(row.article, row.category),
    body: row.article.body,
    site: row.slug,
    site_name: row.name,
    category_id: row.article.categoryId,
    updated_at: row.article.updatedAt.toISOString(),
  };
}
