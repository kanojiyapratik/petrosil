/**
 * The two plain editors: a brand's pages (about, terms, advertise) and the
 * categories its articles are filed under.
 *
 * A page's address is what other sites and old emails link to, so it can be
 * changed but never to one the brand already uses. A category can only be
 * deleted when nothing is filed under it: the old admin deleted it anyway and
 * left its articles pointing at nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { articleCategories, articles, auditLog, memberships, pages, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { deletePage, pageForEdit, savePage } from "@/domain/content/pages";
import { deleteCategory, saveCategory } from "@/domain/content/categories";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

async function withRole(brand: Brand, permissions: string[]) {
  const [role] = await db().insert(roles).values({ name: `Role ${permissions.join(" ")}` }).returning();

  for (const permission of permissions) {
    await db().insert(rolePermissions).values({ roleId: role!.id, permission });
  }

  await db().insert(memberships).values({ userId: staff, siteId: brand.siteId, role: "staff", roleId: role!.id });

  return guard([brand.siteId]);
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

/* ------------------------------------------------------------------ pages */

describe("a page", () => {
  it("is created with an address from its title unless one is given", async () => {
    const made = await savePage(guard([]), { site: "baseoil", title: "Advertise With Us", body: "<p>Rates</p>" });
    const given = await savePage(guard([]), { site: "baseoil", title: "Privacy", slug: "privacy-policy", body: "x" });

    expect(made).toMatchObject({ slug: "advertise-with-us" });
    expect(given).toMatchObject({ slug: "privacy-policy" });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "page.create"));

    expect(entry).toMatchObject({ siteId: baseoil.siteId, userId: staff });
  });

  it("refuses an address the brand already uses, but not one another brand uses", async () => {
    await savePage(guard([]), { site: "baseoil", title: "About", body: "x" });

    await expect(savePage(guard([]), { site: "baseoil", title: "About us", slug: "about", body: "y" })).rejects.toMatchObject({
      field: "slug",
      status: 409,
    });
    await expect(savePage(guard([]), { site: "bitumart", title: "About", body: "z" })).resolves.toMatchObject({ slug: "about" });
  });

  it("changes its title, body, address and whether it is shown", async () => {
    const made = (await savePage(guard([]), { site: "baseoil", title: "Terms", body: "old" }))!;

    const saved = await savePage(guard([]), { id: made.id, title: "Terms of use", slug: "terms-of-use", body: "new", visible: false });

    expect(saved).toMatchObject({ title: "Terms of use", slug: "terms-of-use", visible: false });

    const edit = await pageForEdit([], made.id);

    expect(edit).toMatchObject({ body: "new", site: "baseoil" });
  });

  it("refuses a blank title and an address with spaces", async () => {
    await expect(savePage(guard([]), { site: "baseoil", title: " ", body: "x" })).rejects.toMatchObject({ field: "title" });
    await expect(savePage(guard([]), { site: "baseoil", title: "X", slug: "two words", body: "x" })).rejects.toMatchObject({
      field: "slug",
    });
  });

  it("answers another brand's page as missing, and is deleted for good", async () => {
    const theirs = (await savePage(guard([]), { site: "bitumart", title: "Theirs", body: "x" }))!;

    expect(await savePage(guard([baseoil.siteId]), { id: theirs.id, title: "Mine", body: "x" })).toBeNull();
    expect(await pageForEdit([baseoil.siteId], theirs.id)).toBeNull();
    expect(await deletePage(guard([baseoil.siteId]), theirs.id)).toBe(false);

    expect(await deletePage(guard([]), theirs.id)).toBe(true);
    expect(await db().select().from(pages).where(eq(pages.id, theirs.id))).toEqual([]);
  });

  it("needs the page permissions when the editor holds a role", async () => {
    const limited = await withRole(baseoil, ["page-list"]);

    await expect(savePage(limited, { site: "baseoil", title: "X", body: "x" })).rejects.toBeInstanceOf(AccessError);
  });
});

/* ------------------------------------------------------------- categories */

describe("a category", () => {
  it("is created with a slug from its name, and renamed without moving its slug", async () => {
    const made = (await saveCategory(guard([]), { site: "baseoil", name: "Market News", sort_order: "2" }))!;

    expect(made).toMatchObject({ slug: "market-news", sort_order: 2 });

    const renamed = await saveCategory(guard([]), { id: made.id, name: "Market news & views", sort_order: "1" });

    expect(renamed).toMatchObject({ name: "Market news & views", slug: "market-news", sort_order: 1 });
  });

  it("gets a numbered slug when the brand already has the name", async () => {
    await saveCategory(guard([]), { site: "baseoil", name: "News" });

    expect(await saveCategory(guard([]), { site: "baseoil", name: "News" })).toMatchObject({ slug: "news-2" });
  });

  it("cannot be deleted while articles are filed under it", async () => {
    const made = (await saveCategory(guard([]), { site: "baseoil", name: "News" }))!;

    await db()
      .insert(articles)
      .values({ siteId: baseoil.siteId, categoryId: made.id, slug: "a", title: "A", body: "x", status: "published" });

    await expect(deleteCategory(guard([]), made.id)).rejects.toMatchObject({ status: 409 });

    await db().delete(articles);

    expect(await deleteCategory(guard([]), made.id)).toBe(true);
    expect(await db().select().from(articleCategories).where(eq(articleCategories.id, made.id))).toEqual([]);
  });

  it("is not another brand's staff's to change", async () => {
    const theirs = (await saveCategory(guard([]), { site: "bitumart", name: "Theirs" }))!;

    expect(await saveCategory(guard([baseoil.siteId]), { id: theirs.id, name: "Mine" })).toBeNull();
    await expect(saveCategory(guard([bitumart.siteId]), { site: "baseoil", name: "X" })).rejects.toMatchObject({ status: 403 });

    const limited = await withRole(baseoil, ["category-list"]);

    await expect(saveCategory(limited, { site: "baseoil", name: "X" })).rejects.toBeInstanceOf(AccessError);
  });
});
