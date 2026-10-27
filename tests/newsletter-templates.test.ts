/**
 * Newsletter templates: the layouts a new issue is composed from.
 *
 * Composing fills four placeholders — {articles}, {report}, {offers},
 * {impex-data} — and empties every other one, so saving a template says
 * which of its placeholders will come out empty. A template issues were
 * composed from cannot be deleted, only switched off.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, newsletterTemplates, newsletters, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { deleteTemplate, saveTemplate, templateForEdit } from "@/domain/content/newsletter-templates";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("a newsletter template", () => {
  it("is saved, and says which of its placeholders composing will leave empty", async () => {
    const made = await saveTemplate(guard([]), {
      site: "baseoil",
      title: "Weekly",
      body: "<h1>This week</h1>{articles}{report}<aside>{premium_user}</aside>{sidebar}",
      enabled: true,
    });

    expect(made.unfilled).toEqual(["premium_user", "sidebar"]);

    const [row] = await db().select().from(newsletterTemplates).where(eq(newsletterTemplates.id, made.id));

    expect(row).toMatchObject({ siteId: baseoil.siteId, title: "Weekly", enabled: true });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "newsletter-template.create"));

    expect(entry).toMatchObject({ entityId: made.id });
  });

  it("refuses a title the brand already uses, and an empty body", async () => {
    await saveTemplate(guard([]), { site: "baseoil", title: "Weekly", body: "{articles}", enabled: true });

    await expect(saveTemplate(guard([]), { site: "baseoil", title: "weekly", body: "x", enabled: true })).rejects.toMatchObject({
      field: "title",
      status: 409,
    });
    await expect(saveTemplate(guard([]), { site: "baseoil", title: "Other", body: "  ", enabled: true })).rejects.toMatchObject({
      field: "body",
    });
    await expect(saveTemplate(guard([]), { site: "bitumart", title: "Weekly", body: "x", enabled: true })).resolves.toBeTruthy();
  });

  it("is changed and switched off, and shows how many issues used it", async () => {
    const made = await saveTemplate(guard([]), { site: "baseoil", title: "Weekly", body: "{articles}", enabled: true });

    await db().insert(newsletters).values({ siteId: baseoil.siteId, templateId: made.id, title: "Issue 1", body: "x", status: "draft" });

    await saveTemplate(guard([]), { id: made.id, title: "Weekly v2", body: "{offers}", enabled: false });

    expect(await templateForEdit([], made.id)).toMatchObject({ title: "Weekly v2", body: "{offers}", enabled: false, used_by: 1 });
  });

  it("cannot be deleted once an issue was composed from it", async () => {
    const used = await saveTemplate(guard([]), { site: "baseoil", title: "Used", body: "{articles}", enabled: true });
    const unused = await saveTemplate(guard([]), { site: "baseoil", title: "Unused", body: "{articles}", enabled: true });

    await db().insert(newsletters).values({ siteId: baseoil.siteId, templateId: used.id, title: "Issue", body: "x", status: "draft" });

    await expect(deleteTemplate(guard([]), used.id)).rejects.toMatchObject({ status: 409 });
    expect(await deleteTemplate(guard([]), unused.id)).toBe(true);
  });

  it("is not another brand's staff's, nor a role's without template-create", async () => {
    const theirs = await saveTemplate(guard([]), { site: "bitumart", title: "Theirs", body: "x", enabled: true });

    expect(await templateForEdit([baseoil.siteId], theirs.id)).toBeNull();
    await expect(saveTemplate(guard([baseoil.siteId]), { id: theirs.id, title: "Mine", body: "x", enabled: true })).rejects.toMatchObject({
      status: 404,
    });

    const [role] = await db().insert(roles).values({ name: "Reader" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "template-list" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(
      saveTemplate(guard([baseoil.siteId]), { site: "baseoil", title: "New", body: "x", enabled: true }),
    ).rejects.toBeInstanceOf(AccessError);
  });
});
