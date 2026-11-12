/**
 * What the content team asked for: article keywords, an author on reports and
 * impex sheets, a Deleted list with Restore for reports, offers and impex,
 * and each brand's own pages edited one at a time.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { articles, auditLog, memberships, pages, users } from "@/db/schema";
import { createArticle, keywordsFrom, staffArticles, updateArticle } from "@/domain/content/articles";
import { createReport, reportForEdit, restoreReport, updateReport, withdrawReport } from "@/domain/reports/editor";
import { createImpex, impexForEdit, restoreImpex, updateImpex, withdrawImpex } from "@/domain/impex/editor";
import { createOffer, restoreOffer, withdrawOffer } from "@/domain/offers/editor";
import { listImpex, listOffers, listReports } from "@/domain/dashboard/publishing";
import { pageForEdit, savePage } from "@/domain/content/pages";
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

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  editor = await person("editor@petrosil.com", "Editor Person", "staff");
});

describe("article keywords", () => {
  it("are tidied: split on commas, trimmed, repeats dropped", () => {
    expect(keywordsFrom(" Thailand,AMEA , thailand,, Group II ")).toBe("Thailand, AMEA, Group II");
    expect(keywordsFrom("  ")).toBeNull();
    expect(keywordsFrom(undefined)).toBeNull();
    expect(keywordsFrom(Array.from({ length: 80 }, (_, i) => `keyword${i}`).join(","))!.length).toBeLessThanOrEqual(255);
  });

  it("are saved, changed, and found by the search", async () => {
    const made = await createArticle(guard(), { site: "baseoil", title: "Asia demand", body: "", keywords: "Thailand, AMEA" });

    await updateArticle(guard(), made.id, { keywords: "Vietnam,Singapore" });

    const [row] = await db().select().from(articles).where(eq(articles.id, made.id));

    expect(row!.keywords).toBe("Vietnam, Singapore");
    expect((await staffArticles([], { site: "baseoil", search: "singapore" })).map((a) => a.id)).toEqual([made.id]);
  });
});

describe("authors on reports and impex sheets", () => {
  it("start as the editor, can be changed to one of Petrosil's people, and refuse anyone else", async () => {
    const poonam = await person("poonam@petrosil.com", "Poonam");
    const reader = await person("reader@company.example", "A Reader", "subscriber");

    const report = await createReport(guard(), { site: "baseoil", title: "Weekly", report_type: "weekly" });
    const sheet = await createImpex(guard(), { site: "baseoil", title: "June imports" });

    expect((await reportForEdit([], report.id))!.author_id).toBe(editor);
    expect((await impexForEdit([], sheet.id))!.author_id).toBe(editor);

    await updateReport(guard(), report.id, { author_id: poonam });
    await updateImpex(guard(), sheet.id, { author_id: null });

    expect((await reportForEdit([], report.id))!.author_id).toBe(poonam);
    expect((await impexForEdit([], sheet.id))!.author_id).toBeNull();

    await expect(updateReport(guard(), report.id, { author_id: reader })).rejects.toThrow("Choose an author from the list.");
  });
});

describe("deleting and restoring", () => {
  it("puts a report, an offer and a sheet under Deleted, and Restore brings each back", async () => {
    const report = await createReport(guard(), { site: "baseoil", title: "Weekly", report_type: "weekly" });
    const sheet = await createImpex(guard(), { site: "baseoil", title: "June imports" });
    const offer = await createOffer(guard(), { site: "baseoil", subject: "SN 500 for sale", offer_type: "sell" });

    await withdrawReport(guard(), report.id);
    await withdrawImpex(guard(), sheet.id);
    await withdrawOffer(guard(), offer.id);

    expect((await listReports([], { site: "baseoil" })).rows).toHaveLength(0);
    expect((await listReports([], { site: "baseoil", status: "deleted" })).rows.map((r) => r.id)).toEqual([report.id]);
    expect((await listImpex([], { site: "baseoil", status: "deleted" })).rows.map((r) => r.id)).toEqual([sheet.id]);
    expect((await listOffers([], { site: "baseoil", status: "deleted" })).rows.map((r) => r.id)).toEqual([offer.id]);

    expect(await restoreReport(guard(), report.id)).toBe(true);
    expect(await restoreImpex(guard(), sheet.id)).toBe(true);
    expect(await restoreOffer(guard(), offer.id)).toBe(true);

    expect((await listReports([], { site: "baseoil" })).rows.map((r) => r.id)).toEqual([report.id]);
    expect((await listImpex([], { site: "baseoil" })).rows.map((r) => r.id)).toEqual([sheet.id]);
    expect((await listOffers([], { site: "baseoil" })).rows.map((r) => r.id)).toEqual([offer.id]);
    expect(await db().select().from(auditLog).where(eq(auditLog.action, "report.restore"))).toHaveLength(1);
  });

  it("does not restore what was never deleted", async () => {
    const report = await createReport(guard(), { site: "baseoil", title: "Weekly", report_type: "weekly" });

    expect(await restoreReport(guard(), report.id)).toBe(false);
  });
});

describe("a brand's own page", () => {
  it("is saved with its new title, text and visibility, and keeps its address", async () => {
    const [made] = await db()
      .insert(pages)
      .values({ siteId: baseoil.siteId, slug: "about-us", title: "About Us", body: "<p>Old</p>" })
      .returning();

    await savePage(guard(), { id: made!.id, title: "About Base Oil Report", body: "<p>New <strong>words</strong></p>", visible: false });

    const page = (await pageForEdit([], made!.id))!;

    expect(page.title).toBe("About Base Oil Report");
    expect(page.body).toBe("<p>New <strong>words</strong></p>");
    expect(page.visible).toBe(false);
    expect(page.slug).toBe("about-us");
  });
});
