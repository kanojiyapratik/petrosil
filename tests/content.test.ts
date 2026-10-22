/**
 * Articles, the content pages and the announcement strip.
 *
 * Two things are worth testing hard. A draft must never be reachable from the
 * public side — the old estate's article route read by id with no status check,
 * so an unpublished piece was one guessed number away. And a locked article
 * must keep its body out of the reply entirely, not merely out of the screen.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";

import { GET as listRoute } from "@/app/api/public/[site]/articles/route";
import { GET as detailRoute } from "@/app/api/public/[site]/articles/[slug]/route";
import { GET as pageRoute } from "@/app/api/public/[site]/pages/[slug]/route";
import { GET as announcementsRoute } from "@/app/api/public/[site]/announcements/route";
import {
  GET as staffListRoute,
  POST as staffCreateRoute,
} from "@/app/api/dashboard/articles/route";
import {
  DELETE as staffDeleteRoute,
  PATCH as staffPatchRoute,
} from "@/app/api/dashboard/articles/[id]/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";

import { db } from "@/db";
import { articleForEdit } from "@/domain/content/articles";
import { announcements, articleCategories, articles, auditLog, memberships, pages, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { dayOffset, makeBrand, resetDatabase, type Brand } from "./helpers";

const PASSWORD = "hunter22!";

let baseoil: Brand;
let bitumart: Brand;
let categoryId: number;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB"]);
  bitumart = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

  const [category] = await db()
    .insert(articleCategories)
    .values({ siteId: baseoil.siteId, slug: "market-news", name: "Market news" })
    .returning();

  categoryId = category!.id;
});

async function person(
  email: string,
  grants: { brand: Brand; role?: string; tier?: string; expiresAt?: string | null }[],
): Promise<number> {
  const [row] = await db()
    .insert(users)
    .values({
      email,
      name: email.split("@")[0]!,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    })
    .returning();

  for (const grant of grants) {
    await db().insert(memberships).values({
      userId: row!.id,
      siteId: grant.brand.siteId,
      role: grant.role ?? "subscriber",
      tier: grant.tier ?? "free",
      expiresAt: grant.expiresAt ?? null,
    });
  }

  return row!.id;
}

async function signedIn(email: string): Promise<string> {
  const response = await loginRoute(
    new Request("http://platform.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );

  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function article(
  brand: Brand,
  over: Partial<typeof articles.$inferInsert> = {},
): Promise<typeof articles.$inferSelect> {
  const [row] = await db()
    .insert(articles)
    .values({
      siteId: brand.siteId,
      slug: over.slug ?? `piece-${Math.random().toString(36).slice(2, 8)}`,
      title: over.title ?? "A piece of analysis",
      excerpt: over.excerpt ?? "The opening lines, which everyone may read.",
      body: over.body ?? "THEBODYTEXT, which only a subscriber may read.",
      status: over.status ?? "published",
      publishedAt: over.publishedAt ?? new Date(Date.now() - 60_000),
      premiumOnly: over.premiumOnly ?? false,
      categoryId: over.categoryId ?? null,
      ...over,
    })
    .returning();

  return row!;
}

const get = (url: string, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, { headers: cookie ? { cookie } : {} });

const send = (url: string, method: string, body: unknown, cookie?: string): Request =>
  new Request(`http://platform.test${url}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const context = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

/* ------------------------------------------------------- the public list */

describe("the article list", () => {
  it("shows what has been published", async () => {
    await article(baseoil, { title: "Published piece", slug: "published-piece" });

    const body = await (
      await listRoute(get("/api/public/baseoil/articles"), context({ site: "baseoil" }))
    ).json();

    expect(body.articles).toHaveLength(1);
    expect(body.articles[0]).toMatchObject({ title: "Published piece", slug: "published-piece" });
  });

  it("never shows a draft", async () => {
    await article(baseoil, { status: "draft", slug: "not-ready", publishedAt: null });

    const body = await (
      await listRoute(get("/api/public/baseoil/articles"), context({ site: "baseoil" }))
    ).json();

    expect(body.articles).toEqual([]);
  });

  it("never shows a piece dated for later", async () => {
    await article(baseoil, {
      slug: "embargoed",
      publishedAt: new Date(Date.now() + 86_400_000),
    });

    const body = await (
      await listRoute(get("/api/public/baseoil/articles"), context({ site: "baseoil" }))
    ).json();

    // An embargo kept by a date in the future is an embargo only if the
    // query reads it.
    expect(body.articles).toEqual([]);
  });

  it("leaves a deleted piece out", async () => {
    const piece = await article(baseoil, { slug: "withdrawn" });

    await db().update(articles).set({ deletedAt: new Date() }).where(eq(articles.id, piece.id));

    const body = await (
      await listRoute(get("/api/public/baseoil/articles"), context({ site: "baseoil" }))
    ).json();

    expect(body.articles).toEqual([]);
  });

  it("shows only this brand's writing", async () => {
    await article(baseoil, { slug: "ours" });
    await article(bitumart, { slug: "theirs" });

    const body = await (
      await listRoute(get("/api/public/baseoil/articles"), context({ site: "baseoil" }))
    ).json();

    expect(body.articles.map((a: { slug: string }) => a.slug)).toEqual(["ours"]);
  });

  it("never carries a body, locked or not, because a list does not need one", async () => {
    await article(baseoil, { slug: "open", premiumOnly: false });

    const text = await (
      await listRoute(get("/api/public/baseoil/articles"), context({ site: "baseoil" }))
    ).text();

    expect(text).not.toContain("THEBODYTEXT");
    expect(text).toContain("The opening lines");
  });

  it("filters by category", async () => {
    await article(baseoil, { slug: "in-category", categoryId });
    await article(baseoil, { slug: "no-category" });

    const body = await (
      await listRoute(
        get("/api/public/baseoil/articles?category=market-news"),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body.articles.map((a: { slug: string }) => a.slug)).toEqual(["in-category"]);
  });

  it("pages through, newest first, and says how many there are", async () => {
    for (let n = 0; n < 5; n += 1) {
      await article(baseoil, {
        slug: `piece-${n}`,
        publishedAt: new Date(Date.now() - (5 - n) * 60_000),
      });
    }

    const body = await (
      await listRoute(
        get("/api/public/baseoil/articles?limit=2&offset=0"),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body.total).toBe(5);
    expect(body.articles.map((a: { slug: string }) => a.slug)).toEqual(["piece-4", "piece-3"]);
  });

  it("searches titles", async () => {
    await article(baseoil, { slug: "base-oil-piece", title: "Base oil holds firm" });
    await article(baseoil, { slug: "other", title: "Something else entirely" });

    const body = await (
      await listRoute(
        get("/api/public/baseoil/articles?q=holds"),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body.articles.map((a: { slug: string }) => a.slug)).toEqual(["base-oil-piece"]);
  });
});

/* ----------------------------------------------------------- one article */

describe("reading one article", () => {
  it("gives the whole thing when it is open to everyone", async () => {
    await article(baseoil, { slug: "open-piece", premiumOnly: false });

    const body = await (
      await detailRoute(
        get("/api/public/baseoil/articles/open-piece"),
        context({ site: "baseoil", slug: "open-piece" }),
      )
    ).json();

    expect(body.locked).toBe(false);
    expect(body.article.body).toContain("THEBODYTEXT");
  });

  it("holds a premium piece back from a visitor, keeping the excerpt", async () => {
    await article(baseoil, { slug: "paid-piece", premiumOnly: true });

    const response = await detailRoute(
      get("/api/public/baseoil/articles/paid-piece"),
      context({ site: "baseoil", slug: "paid-piece" }),
    );
    const text = await response.text();
    const body = JSON.parse(text);

    expect(body.locked).toBe(true);
    expect(body.article.body).toBeNull();
    expect(body.article.excerpt).toContain("The opening lines");
    expect(text).not.toContain("THEBODYTEXT");
  });

  it("gives a premium piece to a subscriber", async () => {
    await article(baseoil, { slug: "paid-piece", premiumOnly: true });
    await person("payer@company.example", [{ brand: baseoil, tier: "premium" }]);
    const cookie = await signedIn("payer@company.example");

    const body = await (
      await detailRoute(
        get("/api/public/baseoil/articles/paid-piece", cookie),
        context({ site: "baseoil", slug: "paid-piece" }),
      )
    ).json();

    expect(body.locked).toBe(false);
    expect(body.article.body).toContain("THEBODYTEXT");
  });

  it("still refuses a premium piece to a lapsed subscriber", async () => {
    await article(baseoil, { slug: "paid-piece", premiumOnly: true });
    await person("lapsed@company.example", [
      { brand: baseoil, tier: "premium", expiresAt: dayOffset(new Date(), -1) },
    ]);
    const cookie = await signedIn("lapsed@company.example");

    const body = await (
      await detailRoute(
        get("/api/public/baseoil/articles/paid-piece", cookie),
        context({ site: "baseoil", slug: "paid-piece" }),
      )
    ).json();

    expect(body.locked).toBe(true);
    expect(body.article.body).toBeNull();
  });

  it("answers 404 for a draft, not 403, so a guessed slug tells nobody anything", async () => {
    await article(baseoil, { slug: "not-ready", status: "draft", publishedAt: null });

    const response = await detailRoute(
      get("/api/public/baseoil/articles/not-ready"),
      context({ site: "baseoil", slug: "not-ready" }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for another brand's article", async () => {
    await article(bitumart, { slug: "theirs" });

    const response = await detailRoute(
      get("/api/public/baseoil/articles/theirs"),
      context({ site: "baseoil", slug: "theirs" }),
    );

    expect(response.status).toBe(404);
  });

  it("counts a read", async () => {
    const piece = await article(baseoil, { slug: "counted" });

    await detailRoute(
      get("/api/public/baseoil/articles/counted"),
      context({ site: "baseoil", slug: "counted" }),
    );

    const [after] = await db().select().from(articles).where(eq(articles.id, piece.id));

    expect(after!.views).toBe(1);
  });
});

/* -------------------------------------------------------- staff screens */

describe("the article screens staff use", () => {
  it("are refused to a reader", async () => {
    await person("reader@company.example", [{ brand: baseoil, tier: "premium" }]);
    const cookie = await signedIn("reader@company.example");

    expect((await staffListRoute(get("/api/dashboard/articles", cookie))).status).toBe(403);
  });

  it("show drafts, which the public list does not", async () => {
    await article(baseoil, { slug: "draft-piece", status: "draft", publishedAt: null });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const body = await (await staffListRoute(get("/api/dashboard/articles", cookie))).json();

    expect(body.articles.map((a: { slug: string }) => a.slug)).toEqual(["draft-piece"]);
  });

  it("hide another brand's writing from staff who cannot see it", async () => {
    await article(bitumart, { slug: "theirs" });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const body = await (await staffListRoute(get("/api/dashboard/articles", cookie))).json();

    expect(body.articles).toEqual([]);
  });

  it("write a new piece as a draft, with a slug made from the title", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffCreateRoute(
      send(
        "/api/dashboard/articles",
        "POST",
        { site: "baseoil", title: "Base Oil Holds Firm in Asia", body: "Words." },
        cookie,
      ),
    );

    expect(response.status).toBe(201);

    const body = await response.json();

    expect(body.article).toMatchObject({
      slug: "base-oil-holds-firm-in-asia",
      status: "draft",
      published_at: null,
    });
  });

  it("do not let two pieces on one brand share a slug", async () => {
    await article(baseoil, { slug: "base-oil-holds-firm", title: "Base oil holds firm" });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffCreateRoute(
      send(
        "/api/dashboard/articles",
        "POST",
        { site: "baseoil", title: "Base oil holds firm", body: "Words." },
        cookie,
      ),
    );

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.article.slug).toBe("base-oil-holds-firm-2");
  });

  it("refuse a piece for a brand this editor cannot see", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffCreateRoute(
      send(
        "/api/dashboard/articles",
        "POST",
        { site: "bitumart", title: "Not mine", body: "Words." },
        cookie,
      ),
    );

    expect(response.status).toBe(403);
  });

  it("refuse a piece with no title", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffCreateRoute(
      send("/api/dashboard/articles", "POST", { site: "baseoil", title: "  ", body: "Words." }, cookie),
    );

    expect(response.status).toBe(422);
  });

  it("publish a draft, stamping the moment it went out", async () => {
    const piece = await article(baseoil, { slug: "to-publish", status: "draft", publishedAt: null });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffPatchRoute(
      send(`/api/dashboard/articles/${piece.id}`, "PATCH", { status: "published" }, cookie),
      context({ id: String(piece.id) }),
    );

    expect(response.status).toBe(200);

    const [after] = await db().select().from(articles).where(eq(articles.id, piece.id));

    expect(after!.status).toBe("published");
    expect(after!.publishedAt).not.toBeNull();

    const [logged] = await db().select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);

    expect(logged).toMatchObject({ action: "article.publish", entityId: piece.id });
  });

  it("do not move the publication date when an already-published piece is edited", async () => {
    const published = new Date(Date.now() - 86_400_000);
    const piece = await article(baseoil, { slug: "already-out", publishedAt: published });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    await staffPatchRoute(
      send(
        `/api/dashboard/articles/${piece.id}`,
        "PATCH",
        { title: "A corrected headline", status: "published" },
        cookie,
      ),
      context({ id: String(piece.id) }),
    );

    const [after] = await db().select().from(articles).where(eq(articles.id, piece.id));

    // Fixing a typo must not re-date a piece to the top of the list.
    expect(after!.publishedAt?.toISOString()).toBe(published.toISOString());
    expect(after!.title).toBe("A corrected headline");
  });

  it("answer 404 when editing another brand's piece", async () => {
    const piece = await article(bitumart, { slug: "theirs" });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffPatchRoute(
      send(`/api/dashboard/articles/${piece.id}`, "PATCH", { title: "Hijacked" }, cookie),
      context({ id: String(piece.id) }),
    );

    expect(response.status).toBe(404);

    const [after] = await db().select().from(articles).where(eq(articles.id, piece.id));

    expect(after!.title).toBe("A piece of analysis");
  });

  it("withdraw a piece without destroying it", async () => {
    const piece = await article(baseoil, { slug: "withdraw-me" });
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffDeleteRoute(
      send(`/api/dashboard/articles/${piece.id}`, "DELETE", undefined, cookie),
      context({ id: String(piece.id) }),
    );

    expect(response.status).toBe(200);

    const [after] = await db().select().from(articles).where(eq(articles.id, piece.id));

    // Soft: twenty years of writing is not something an endpoint should be
    // able to erase, and the row is still the target of any link ever shared.
    expect(after).toBeDefined();
    expect(after!.deletedAt).not.toBeNull();
  });
});

/* ------------------------------------------------------- pages and strips */

describe("the content pages", () => {
  beforeEach(async () => {
    await db()
      .insert(pages)
      .values([
        { siteId: baseoil.siteId, slug: "methodology", title: "Methodology", body: "How we assess." },
        { siteId: baseoil.siteId, slug: "hidden", title: "Hidden", body: "Not ready.", visible: false },
      ]);
  });

  it("gives a page by its slug", async () => {
    const body = await (
      await pageRoute(
        get("/api/public/baseoil/pages/methodology"),
        context({ site: "baseoil", slug: "methodology" }),
      )
    ).json();

    expect(body.page).toMatchObject({ title: "Methodology", body: "How we assess." });
  });

  it("answers 404 for a page that is switched off", async () => {
    const response = await pageRoute(
      get("/api/public/baseoil/pages/hidden"),
      context({ site: "baseoil", slug: "hidden" }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for another brand's page", async () => {
    const response = await pageRoute(
      get("/api/public/bitumart/pages/methodology"),
      context({ site: "bitumart", slug: "methodology" }),
    );

    expect(response.status).toBe(404);
  });
});

describe("the announcement strip", () => {
  it("shows one that is running now", async () => {
    await db()
      .insert(announcements)
      .values({ siteId: baseoil.siteId, body: "Prices now twice weekly." });

    const body = await (
      await announcementsRoute(
        get("/api/public/baseoil/announcements"),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body.announcements).toHaveLength(1);
  });

  it("leaves out one that has not started, one that has finished, and one switched off", async () => {
    await db()
      .insert(announcements)
      .values([
        { siteId: baseoil.siteId, body: "Later", startsAt: dayOffset(new Date(), 5) },
        { siteId: baseoil.siteId, body: "Over", endsAt: dayOffset(new Date(), -5) },
        { siteId: baseoil.siteId, body: "Off", enabled: false },
      ]);

    const body = await (
      await announcementsRoute(
        get("/api/public/baseoil/announcements"),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body.announcements).toEqual([]);
  });

  it("shows one on its last day", async () => {
    await db()
      .insert(announcements)
      .values({ siteId: baseoil.siteId, body: "Ends today", endsAt: dayOffset(new Date(), 0) });

    const body = await (
      await announcementsRoute(
        get("/api/public/baseoil/announcements"),
        context({ site: "baseoil" }),
      )
    ).json();

    expect(body.announcements).toHaveLength(1);
  });
});

/**
 * Loading one article to edit.
 *
 * `publishedArticle` is the reader's route: it refuses a draft and counts a
 * view. An editor opening their own unpublished piece must get the body
 * without being refused and without inflating the number the editorial
 * screens rank by.
 */
describe("one article, for its editor", () => {
  it("hands back the body of a draft, which the reader's route refuses", async () => {
    const [draft] = await db()
      .insert(articles)
      .values({
        siteId: baseoil.siteId,
        slug: "singapore-eases",
        title: "Singapore eases",
        body: "<p>The full piece.</p>",
        excerpt: "The hook.",
        status: "draft",
      })
      .returning();

    const found = await articleForEdit([], draft!.id);

    expect(found?.title).toBe("Singapore eases");
    expect(found?.body).toBe("<p>The full piece.</p>");
    expect(found?.status).toBe("draft");
    expect(found?.site).toBe("baseoil");
  });

  it("does not count a view, because an editor opening a piece is not a read", async () => {
    const [piece] = await db()
      .insert(articles)
      .values({
        siteId: baseoil.siteId,
        slug: "a-piece",
        title: "A piece",
        body: "x",
        status: "published",
        publishedAt: new Date(),
      })
      .returning();

    await articleForEdit([], piece!.id);
    await articleForEdit([], piece!.id);

    const [after] = await db().select().from(articles).where(eq(articles.id, piece!.id));

    expect(after!.views).toBe(0);
  });

  it("answers nothing for a brand this viewer cannot see", async () => {
    const [theirs] = await db()
      .insert(articles)
      .values({ siteId: bitumart.siteId, slug: "theirs", title: "Theirs", body: "x" })
      .returning();

    // The same answer as "no such article", so an id cannot be used to find
    // out what a brand you cannot see has written.
    expect(await articleForEdit([baseoil.siteId], theirs!.id)).toBeNull();
  });

  it("treats a withdrawn article as gone, for the editor too", async () => {
    const [gone] = await db()
      .insert(articles)
      .values({
        siteId: baseoil.siteId,
        slug: "gone",
        title: "Gone",
        body: "x",
        deletedAt: new Date(),
      })
      .returning();

    expect(await articleForEdit([], gone!.id)).toBeNull();
  });
});

/**
 * Filing an article under a category.
 *
 * `category_id` arrives as a number from a form and was used as it came.
 * Nothing checked it belonged to the brand being written to, so baseoil's
 * article could be filed under one of bitumart's categories — an id alone
 * deciding what happens, which is the shape of bug this codebase keeps
 * finding in the old console.
 */
describe("the category an article is filed under", () => {
  it("accepts one belonging to the brand being written to", async () => {
    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffCreateRoute(
      send(
        "/api/dashboard/articles",
        "POST",
        { site: "baseoil", title: "Filed properly", category_id: categoryId },
        cookie,
      ),
    );

    expect(response.status).toBe(201);

    const { article } = await response.json();
    const [row] = await db().select().from(articles).where(eq(articles.id, article.id));

    expect(row!.categoryId).toBe(categoryId);
  });

  it("refuses one belonging to a different brand", async () => {
    const [theirs] = await db()
      .insert(articleCategories)
      .values({ siteId: bitumart.siteId, slug: "theirs", name: "Theirs" })
      .returning();

    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const response = await staffCreateRoute(
      send(
        "/api/dashboard/articles",
        "POST",
        { site: "baseoil", title: "Filed wrongly", category_id: theirs!.id },
        cookie,
      ),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).message).toMatch(/categor/i);
  });

  it("refuses it on an update too, not only on the way in", async () => {
    const [theirs] = await db()
      .insert(articleCategories)
      .values({ siteId: bitumart.siteId, slug: "theirs", name: "Theirs" })
      .returning();

    await person("editor@petrosil.example", [{ brand: baseoil, role: "staff" }]);
    const cookie = await signedIn("editor@petrosil.example");

    const made = await staffCreateRoute(
      send("/api/dashboard/articles", "POST", { site: "baseoil", title: "A piece" }, cookie),
    );
    const { article } = await made.json();

    const response = await staffPatchRoute(
      send(`/api/dashboard/articles/${article.id}`, "PATCH", { category_id: theirs!.id }, cookie),
      { params: Promise.resolve({ id: String(article.id) }) },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).message).toMatch(/categor/i);
  });
});
