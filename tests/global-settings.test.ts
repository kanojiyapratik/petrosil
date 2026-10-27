/**
 * Global settings: the things every brand has, edited once.
 *
 * The nine brands each hold their own copy of the same pages, system emails
 * and field-visibility rules, mostly identical but for the brand's name. The
 * global screens group the copies that say the same thing, and apply one
 * version to the brands ticked, with `{brand}` written as each brand's name.
 * Each brand keeps its own row, so one that needs to differ still can.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, formFields, mailTemplates, memberships, pages, rolePermissions, roles, sites, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import {
  applyEmail,
  applyField,
  applyPage,
  brandText,
  globalEmail,
  globalEmails,
  globalFields,
  globalPage,
  globalPages,
  removePage,
} from "@/domain/global/estate";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let wax: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

async function named(brand: Brand, name: string) {
  await db().update(sites).set({ name }).where(eq(sites.id, brand.siteId));
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);
  wax = await makeBrand("waxreport", []);
  await named(baseoil, "Base Oil Report");
  await named(bitumart, "Bitumart");
  await named(wax, "Wax Report");

  const [me] = await db().insert(users).values({ email: "boss@petrosil.example", name: "Boss" }).returning();

  staff = me!.id;
});

describe("the brand marker", () => {
  it("becomes each brand's name", () => {
    expect(brandText("Welcome to {brand}. {brand} is weekly.", "Bitumart")).toBe("Welcome to Bitumart. Bitumart is weekly.");
  });
});

describe("common pages", () => {
  beforeEach(async () => {
    await db()
      .insert(pages)
      .values([
        { siteId: baseoil.siteId, slug: "about-us", title: "About Base Oil Report", body: "<p>Base Oil Report covers base oils.</p>" },
        { siteId: bitumart.siteId, slug: "about-us", title: "About Bitumart", body: "<p>Bitumart covers base oils.</p>" },
        { siteId: wax.siteId, slug: "about-us", title: "About Wax Report", body: "<p>Something else entirely.</p>" },
        { siteId: baseoil.siteId, slug: "terms", title: "Terms", body: "Terms" },
      ]);
  });

  it("groups the brands whose page says the same thing but for their name", async () => {
    const list = await globalPages([]);
    const about = list.find((row) => row.slug === "about-us")!;

    expect(about).toMatchObject({ brands: 3, versions: 2 });

    const detail = (await globalPage([], "about-us"))!;

    expect(detail.versions[0]).toMatchObject({
      title: "About {brand}",
      body: "<p>{brand} covers base oils.</p>",
      brands: [
        { slug: "baseoil", name: "Base Oil Report" },
        { slug: "bitumart", name: "Bitumart" },
      ],
    });
    expect(detail.versions[1]!.brands.map((brand) => brand.slug)).toEqual(["waxreport"]);
    expect(detail.missing).toEqual([]);
    expect((await globalPage([], "terms"))!.missing.map((brand) => brand.slug)).toEqual(["bitumart", "waxreport"]);
  });

  it("applies one version to the brands ticked, creating it where missing", async () => {
    const result = await applyPage(guard([]), {
      slug: "terms",
      title: "{brand} terms",
      body: "<p>Use of {brand} is subject to…</p>",
      visible: true,
      sites: ["baseoil", "waxreport"],
    });

    expect(result).toEqual({ created: 1, updated: 1 });

    const rows = await db().select().from(pages).where(eq(pages.slug, "terms"));
    const bySite = new Map(rows.map((row) => [row.siteId, row]));

    expect(bySite.get(baseoil.siteId)).toMatchObject({ title: "Base Oil Report terms", body: "<p>Use of Base Oil Report is subject to…</p>" });
    expect(bySite.get(wax.siteId)).toMatchObject({ title: "Wax Report terms" });
    expect(bySite.has(bitumart.siteId)).toBe(false);

    const entries = await db().select().from(auditLog).where(eq(auditLog.action, "page.global"));

    expect(entries).toHaveLength(2);
  });

  it("moves a page to a new address on the brands ticked, but not onto one a brand already uses", async () => {
    await applyPage(guard([]), {
      slug: "about-us",
      new_slug: "about",
      title: "About {brand}",
      body: "x",
      visible: true,
      sites: ["baseoil", "bitumart"],
    });

    const rows = await db().select().from(pages).where(eq(pages.slug, "about"));

    expect(rows.map((row) => row.siteId).sort()).toEqual([baseoil.siteId, bitumart.siteId].sort());
    // Wax Report was not ticked, so its page stays where it was.
    expect((await db().select().from(pages).where(eq(pages.slug, "about-us"))).map((row) => row.siteId)).toEqual([wax.siteId]);

    await expect(
      applyPage(guard([]), { slug: "about", new_slug: "terms", title: "T", body: "x", visible: true, sites: ["baseoil"] }),
    ).rejects.toMatchObject({ field: "slug", status: 409 });
  });

  it("deletes a page from the brands ticked, keeping its words in the trail", async () => {
    expect(await removePage(guard([]), { slug: "about-us", sites: ["baseoil", "bitumart"] })).toEqual({ removed: 2 });
    expect((await db().select().from(pages).where(eq(pages.slug, "about-us"))).map((row) => row.siteId)).toEqual([wax.siteId]);

    const entries = await db().select().from(auditLog).where(eq(auditLog.action, "page.delete"));

    expect(entries).toHaveLength(2);
  });

  it("only touches brands the editor manages", async () => {
    await expect(
      applyPage(guard([baseoil.siteId]), { slug: "terms", title: "T", body: "B", visible: true, sites: ["baseoil", "bitumart"] }),
    ).rejects.toMatchObject({ status: 403 });

    const [row] = await db().select().from(pages).where(and(eq(pages.slug, "terms"), eq(pages.siteId, baseoil.siteId)));

    expect(row!.body).toBe("Terms");
  });
});

describe("system emails", () => {
  beforeEach(async () => {
    await db()
      .insert(mailTemplates)
      .values([
        { siteId: baseoil.siteId, key: "welcome", title: "Welcome", subject: "Welcome to Base Oil Report", body: "Hi {name}" },
        { siteId: bitumart.siteId, key: "welcome", title: "Welcome", subject: "Welcome to Bitumart", body: "Hi {name}" },
      ]);
  });

  it("groups and applies like pages, keeping the send-time placeholders as typed", async () => {
    expect((await globalEmails([])).find((row) => row.key === "welcome")).toMatchObject({ brands: 2, versions: 1 });
    expect((await globalEmail([], "welcome", "default"))!.missing.map((brand) => brand.slug)).toEqual(["waxreport"]);

    const result = await applyEmail(guard([]), {
      key: "welcome",
      variant: "default",
      subject: "Welcome to {brand}, {name}",
      body: "<p>Hello {name}, thanks for joining {brand}.</p>",
      enabled: true,
      sites: ["baseoil", "bitumart", "waxreport"],
    });

    expect(result).toEqual({ created: 1, updated: 2 });

    const [wx] = await db()
      .select()
      .from(mailTemplates)
      .where(and(eq(mailTemplates.siteId, wax.siteId), eq(mailTemplates.key, "welcome")));

    expect(wx).toMatchObject({ title: "Welcome", subject: "Welcome to Wax Report, {name}", body: "<p>Hello {name}, thanks for joining Wax Report.</p>" });
  });

  it("needs mail-edit on every brand ticked", async () => {
    const [role] = await db().insert(roles).values({ name: "Writer" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "article-create" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(
      applyEmail(guard([baseoil.siteId]), { key: "welcome", variant: "default", subject: "S", body: "B", enabled: true, sites: ["baseoil"] }),
    ).rejects.toBeInstanceOf(AccessError);
  });
});

describe("field visibility", () => {
  beforeEach(async () => {
    for (const brand of [baseoil, bitumart, wax]) {
      await db()
        .insert(formFields)
        .values([
          { siteId: brand.siteId, form: "directory", key: "phone", label: "Phone", showFree: false, showPremium: true },
          { siteId: brand.siteId, form: "directory", key: "email", label: "Email", showFree: brand === wax, showPremium: true },
        ]);
    }
  });

  it("says where the brands agree and where they differ", async () => {
    const rows = await globalFields([], "directory");
    const phone = rows.find((row) => row.key === "phone")!;
    const email = rows.find((row) => row.key === "email")!;

    expect(phone).toMatchObject({ label: "Phone", agreed: true, free: 0, premium: 3, enabled: 3, brands: 3 });
    expect(email).toMatchObject({ agreed: false, free: 1, premium: 3 });
  });

  it("applies one rule to the brands ticked", async () => {
    const result = await applyField(guard([]), {
      form: "directory",
      key: "email",
      show_free: false,
      show_premium: true,
      enabled: true,
      sites: ["baseoil", "bitumart", "waxreport"],
    });

    expect(result).toEqual({ updated: 3, missing: [] });
    expect((await globalFields([], "directory")).find((row) => row.key === "email")).toMatchObject({ agreed: true, free: 0 });
  });
});
