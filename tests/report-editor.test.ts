/**
 * Writing a report: the title, who may read it, and the PDF behind it.
 *
 * The old form saved whatever file name it was handed, so a report could
 * point at a PDF that was never uploaded and its readers got a dead link.
 * Here the file has to be in the store, in that brand's report folder, before
 * the report may name it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, mediaFiles, memberships, rolePermissions, roles, reports, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { createReport, reportForEdit, updateReport, withdrawReport } from "@/domain/reports/editor";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

async function stored(brand: Brand, folder: string, name: string) {
  await db()
    .insert(mediaFiles)
    .values({ siteId: brand.siteId, path: `${brand.slug}/${folder}/${name}`, folder, name, kind: "application/pdf", bytes: 10 });
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [person] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = person!.id;
});

describe("a new report", () => {
  it("is saved with a slug from its title and an audit entry", async () => {
    await stored(baseoil, "reports/files", "october-2026-ab12cd.pdf");

    const made = await createReport(guard([]), {
      site: "baseoil",
      title: "Base Oil Monthly — October 2026",
      description: "Asia and Middle East.",
      report_type: "report",
      status: "premium",
      authored_on: "2026-10-20",
      file: "october-2026-ab12cd.pdf",
    });

    const [row] = await db().select().from(reports).where(eq(reports.id, made.id));

    expect(row).toMatchObject({
      slug: "base-oil-monthly-october-2026",
      status: "premium",
      authoredOn: "2026-10-20",
      file: "october-2026-ab12cd.pdf",
    });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.entity, "report"));

    expect(entry).toMatchObject({ action: "report.create", entityId: made.id });
  });

  it("gets a numbered slug when the title is already taken", async () => {
    await createReport(guard([]), { site: "baseoil", title: "Weekly", report_type: "report" });
    const second = await createReport(guard([]), { site: "baseoil", title: "Weekly", report_type: "report" });

    expect(second.slug).toBe("weekly-2");
  });

  it("refuses a PDF that is not in the brand's report folder", async () => {
    // In the store, but bitumart's: naming it would hand baseoil's readers
    // another brand's paid file.
    await stored(bitumart, "reports/files", "theirs.pdf");

    await expect(
      createReport(guard([]), { site: "baseoil", title: "X", report_type: "report", file: "theirs.pdf" }),
    ).rejects.toMatchObject({ field: "file" });

    await expect(
      createReport(guard([]), { site: "baseoil", title: "X", report_type: "report", file: "never-uploaded.pdf" }),
    ).rejects.toBeInstanceOf(AccountError);
  });

  it("refuses a thumbnail that is not in the thumbnail folder", async () => {
    await stored(baseoil, "reports/files", "cover.png");

    await expect(
      createReport(guard([]), { site: "baseoil", title: "X", report_type: "report", thumbnail: "cover.png" }),
    ).rejects.toMatchObject({ field: "thumbnail" });
  });

  it("refuses an unknown status and an impossible date", async () => {
    await expect(
      createReport(guard([]), { site: "baseoil", title: "X", report_type: "report", status: "secret" }),
    ).rejects.toMatchObject({ field: "status" });

    await expect(
      createReport(guard([]), { site: "baseoil", title: "X", report_type: "report", authored_on: "2026-02-30" }),
    ).rejects.toMatchObject({ field: "authored_on" });
  });

  it("is a draft unless told otherwise", async () => {
    const made = await createReport(guard([]), { site: "baseoil", title: "X", report_type: "report" });

    expect(made.status).toBe("draft");
  });

  it("cannot be made on a brand the editor was not given", async () => {
    await expect(
      createReport(guard([baseoil.siteId]), { site: "bitumart", title: "X", report_type: "report" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("needs report-create when the editor holds a role", async () => {
    const [role] = await db().insert(roles).values({ name: "Report sender" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "report-send" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(
      createReport(guard([baseoil.siteId]), { site: "baseoil", title: "X", report_type: "report" }),
    ).rejects.toBeInstanceOf(AccessError);
  });
});

describe("changing a report", () => {
  it("changes what it is given and leaves the rest", async () => {
    await stored(baseoil, "reports/files", "new.pdf");
    const made = await createReport(guard([]), {
      site: "baseoil",
      title: "Old title",
      description: "Kept",
      report_type: "report",
    });

    const saved = await updateReport(guard([]), made.id, { title: "New title", file: "new.pdf", status: "published" });

    expect(saved).toMatchObject({ title: "New title", file: "new.pdf", status: "published", description: "Kept" });
    // The address does not move: links already shared keep working.
    expect(saved!.slug).toBe("old-title");
  });

  it("can detach the file", async () => {
    await stored(baseoil, "reports/files", "a.pdf");
    const made = await createReport(guard([]), { site: "baseoil", title: "A", report_type: "report", file: "a.pdf" });

    const saved = await updateReport(guard([]), made.id, { file: null });

    expect(saved!.file).toBeNull();
  });

  it("answers another brand's report as missing", async () => {
    const made = await createReport(guard([]), { site: "bitumart", title: "Theirs", report_type: "report" });

    expect(await updateReport(guard([baseoil.siteId]), made.id, { title: "Mine now" })).toBeNull();
    expect(await reportForEdit([baseoil.siteId], made.id)).toBeNull();
  });
});

describe("withdrawing a report", () => {
  it("takes it off the lists without deleting the row", async () => {
    const made = await createReport(guard([]), { site: "baseoil", title: "Gone", report_type: "report" });

    expect(await withdrawReport(guard([]), made.id)).toBe(true);

    const [row] = await db().select().from(reports).where(eq(reports.id, made.id));

    expect(row!.deletedAt).not.toBeNull();
    expect(await reportForEdit([], made.id)).toBeNull();
  });
});

describe("the editor's view of a report", () => {
  it("says whether its file is actually in the store", async () => {
    await stored(baseoil, "reports/files", "here.pdf");
    const made = await createReport(guard([]), { site: "baseoil", title: "Here", report_type: "report", file: "here.pdf" });

    // A carried report whose PDF never made it across.
    const [carried] = await db()
      .insert(reports)
      .values({ siteId: baseoil.siteId, slug: "carried", title: "Carried", reportType: "report", file: "lost.pdf" })
      .returning();

    expect((await reportForEdit([], made.id))!.file_id).not.toBeNull();
    expect((await reportForEdit([], carried!.id))!.file_id).toBeNull();
  });
});
