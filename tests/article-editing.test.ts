/**
 * The article editor: take down is not delete, delete is soft and can be
 * undone, the author is one of Petrosil's people, and the body is cleaned.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { articles, auditLog, memberships, users } from "@/db/schema";
import {
  articleAuthors,
  articleForEdit,
  createArticle,
  publishedArticles,
  restoreArticle,
  staffArticles,
  updateArticle,
  withdrawArticle,
} from "@/domain/content/articles";
import { editableHtml } from "@/lib/public/html";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let editor: number;

const guard = () =>
  ({ identity: { user: { id: editor, email: "editor@petrosil.com" }, memberships: [] }, siteIds: [], isSuperadmin: true }) as never;

async function person(email: string, name: string, role?: string): Promise<number> {
  const [row] = await db().insert(users).values({ email, name, passwordHash: "x" }).returning();

  if (role) {
    await db().insert(memberships).values({ userId: row!.id, siteId: baseoil.siteId, role, tier: "free" });
  }

  return row!.id;
}

async function piece(): Promise<number> {
  const made = await createArticle(guard(), { site: "baseoil", title: "Base oil holds firm", body: "<p>Steady.</p>" });

  await updateArticle(guard(), made.id, { status: "published" });

  return made.id;
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  editor = await person("editor@petrosil.com", "Editor Person", "staff");
});

describe("taking an article down", () => {
  it("takes it off the brand site but keeps it, not deleted, in the editor's list", async () => {
    const id = await piece();

    await updateArticle(guard(), id, { status: "withdrawn" });

    const [row] = await db().select().from(articles).where(eq(articles.id, id));

    expect(row!.status).toBe("withdrawn");
    expect(row!.deletedAt).toBeNull();
    expect((await publishedArticles(baseoil.siteId)).articles.map((a) => a.id)).not.toContain(id);
    expect((await staffArticles([], { site: "baseoil" })).map((a) => a.id)).toContain(id);
    expect(await articleForEdit([], id)).not.toBeNull();

    const [trail] = await db().select().from(auditLog).where(eq(auditLog.action, "article.take_down"));

    expect(trail?.entityId).toBe(id);
  });

  it("can be published again", async () => {
    const id = await piece();

    await updateArticle(guard(), id, { status: "withdrawn" });
    await updateArticle(guard(), id, { status: "published" });

    expect((await publishedArticles(baseoil.siteId)).articles.map((a) => a.id)).toContain(id);
  });
});

describe("deleting an article", () => {
  it("is soft: the row stays, it leaves the lists and the site, and shows under Deleted", async () => {
    const id = await piece();

    expect(await withdrawArticle(guard(), id)).toBe(true);

    const [row] = await db().select().from(articles).where(eq(articles.id, id));

    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
    expect((await staffArticles([], { site: "baseoil" })).map((a) => a.id)).not.toContain(id);
    expect((await staffArticles([], { site: "baseoil", deleted: true })).map((a) => a.id)).toEqual([id]);
    expect((await publishedArticles(baseoil.siteId)).articles).toHaveLength(0);
  });

  it("can be restored, as it was", async () => {
    const id = await piece();

    await withdrawArticle(guard(), id);
    expect(await restoreArticle(guard(), id)).toBe(true);

    expect((await publishedArticles(baseoil.siteId)).articles.map((a) => a.id)).toContain(id);
    expect((await db().select().from(auditLog).where(and(eq(auditLog.action, "article.restore"), eq(auditLog.entityId, id))))).toHaveLength(1);
  });

  it("does not restore what was never deleted", async () => {
    const id = await piece();

    expect(await restoreArticle(guard(), id)).toBe(false);
  });
});

describe("the author", () => {
  it("is chosen from Petrosil's people and staff, not readers or shared mailboxes", async () => {
    const poonam = await person("poonam@petrosil.com", "Poonam");
    await person("info@petrosil.com", "staff");
    await person("reader@company.example", "A Reader", "subscriber");

    const names = (await articleAuthors()).map((a) => a.name);

    expect(names).toEqual(["Editor Person", "Poonam"]);

    const made = await createArticle(guard(), { site: "baseoil", title: "By Poonam", body: "", author_id: poonam });

    expect((await articleForEdit([], made.id))!.author_id).toBe(poonam);
  });

  it("refuses someone not on the list", async () => {
    const reader = await person("reader@company.example", "A Reader", "subscriber");
    const id = await piece();

    await expect(updateArticle(guard(), id, { author_id: reader })).rejects.toThrow("Choose an author from the list.");
  });

  it("keeps an author carried from the old sites who is not on today's list", async () => {
    const oldAdmin = await person("admin@gmail.com", "Admin");
    const id = await piece();

    await db().update(articles).set({ authorId: oldAdmin }).where(eq(articles.id, id));
    await updateArticle(guard(), id, { title: "Retitled", author_id: oldAdmin });

    expect((await articleForEdit([], id))!.author_id).toBe(oldAdmin);
  });

  it("defaults to the editor on a new piece, and can be left empty", async () => {
    const mine = await createArticle(guard(), { site: "baseoil", title: "Mine", body: "" });
    const nobody = await createArticle(guard(), { site: "baseoil", title: "Unsigned", body: "", author_id: null });

    expect((await articleForEdit([], mine.id))!.author_id).toBe(editor);
    expect((await articleForEdit([], nobody.id))!.author_id).toBeNull();
  });
});

describe("the body", () => {
  it("is cleaned on save: no scripts, styles or event handlers from pasted text", async () => {
    const made = await createArticle(guard(), {
      site: "baseoil",
      title: "Pasted",
      body: '<p style="color:red" onclick="steal()">Hello <strong>there</strong></p><script>steal()</script>',
    });

    const body = (await articleForEdit([], made.id))!.body!;

    expect(body).toBe("<p>Hello <strong>there</strong></p>");
  });

  it("opens a plain-text body in the editor as paragraphs", () => {
    expect(editableHtml("First line\r\nSecond line_x000D_\n\nThird")).toBe("<p>First line</p><p>Second line</p><p>Third</p>");
    expect(editableHtml("<p>Already <em>formatted</em></p>")).toBe("<p>Already <em>formatted</em></p>");
  });
});
