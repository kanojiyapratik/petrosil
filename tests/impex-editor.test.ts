/**
 * Writing an impex sheet: the import and export spreadsheets a brand
 * publishes per period, 5,500 of them across six brands.
 *
 * Like a report, the file has to be in the brand's impex folder before the
 * sheet may name it, and a withdrawn sheet keeps its row.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, impexSheets, mediaFiles, memberships, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { createImpex, impexForEdit, updateImpex, withdrawImpex } from "@/domain/impex/editor";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

async function stored(brand: Brand, name: string) {
  await db()
    .insert(mediaFiles)
    .values({ siteId: brand.siteId, path: `${brand.slug}/impex/files/${name}`, folder: "impex/files", name, kind: "text/csv", bytes: 10 });
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("an impex sheet", () => {
  it("is created with a slug, its file, and an audit entry", async () => {
    await stored(baseoil, "india-imports-sep-2026.xlsx");

    const made = await createImpex(guard([]), {
      site: "baseoil",
      title: "India base oil imports — September 2026",
      status: "premium",
      authored_on: "2026-10-15",
      file: "india-imports-sep-2026.xlsx",
    });

    const [row] = await db().select().from(impexSheets).where(eq(impexSheets.id, made.id));

    expect(row).toMatchObject({
      slug: "india-base-oil-imports-september-2026",
      status: "premium",
      authoredOn: "2026-10-15",
      file: "india-imports-sep-2026.xlsx",
    });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "impex.create"));

    expect(entry).toMatchObject({ entityId: made.id });
  });

  it("refuses a file not in the brand's impex folder, and an unknown status", async () => {
    await expect(createImpex(guard([]), { site: "baseoil", title: "X", file: "nowhere.xlsx" })).rejects.toMatchObject({
      field: "file",
    });
    await expect(createImpex(guard([]), { site: "baseoil", title: "X", status: "secret" })).rejects.toMatchObject({
      field: "status",
    });
  });

  it("is a draft unless told otherwise, and changes only what it is given", async () => {
    const made = await createImpex(guard([]), { site: "baseoil", title: "Old", description: "Kept" });

    expect(made.status).toBe("draft");

    const saved = await updateImpex(guard([]), made.id, { title: "New", status: "published" });

    expect(saved).toMatchObject({ title: "New", status: "published", description: "Kept", slug: "old" });
  });

  it("answers another brand's sheet as missing, and is withdrawn not deleted", async () => {
    const theirs = await createImpex(guard([]), { site: "bitumart", title: "Theirs" });

    expect(await updateImpex(guard([baseoil.siteId]), theirs.id, { title: "Mine" })).toBeNull();
    expect(await impexForEdit([baseoil.siteId], theirs.id)).toBeNull();

    expect(await withdrawImpex(guard([]), theirs.id)).toBe(true);

    const [row] = await db().select().from(impexSheets).where(eq(impexSheets.id, theirs.id));

    expect(row!.deletedAt).not.toBeNull();
  });

  it("needs impex-create when the editor holds a role", async () => {
    const [role] = await db().insert(roles).values({ name: "Impex reader" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "impex-list" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(createImpex(guard([baseoil.siteId]), { site: "baseoil", title: "X" })).rejects.toBeInstanceOf(AccessError);
  });
});
