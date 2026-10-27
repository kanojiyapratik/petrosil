/**
 * Who can get into the admin, and what each person may do there.
 *
 * The migration granted nobody, on purpose, so until this existed only the
 * one seeded superadmin could sign in. Granting access is a superadmin's job
 * alone. A staff member with no named role keeps what staff have always had —
 * everything on their brands; a named role narrows that to its permissions,
 * which, unlike on the old sites, are actually checked.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { POST as loginRoute } from "@/app/api/auth/login/route";
import { db } from "@/db";
import { auditLog, mailOutbox, memberships, rolePermissions, roles, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/passwords";
import { AccessError } from "@/lib/auth/guard";
import {
  acceptStaffInvite,
  grantStaff,
  makeSuperadmin,
  revokeStaff,
} from "@/domain/staff/manage";
import { deleteRole, saveRole } from "@/domain/staff/roles";
import { can, orRefused, requirePermission } from "@/domain/staff/permissions";
import { saveAnnouncement } from "@/domain/content/pages";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let boss: number;

/** A signed-in person as the admin sees them. */
async function viewer(userId: number) {
  const rows = await db()
    .select({ siteId: memberships.siteId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  const superadmin = rows.some((row) => row.role === "superadmin");

  return {
    identity: { user: { id: userId }, memberships: rows.map((row) => ({ ...row, slug: "", tier: "free", expiresAt: null })) },
    siteIds: superadmin ? [] : rows.filter((row) => row.role === "staff").map((row) => row.siteId),
    isSuperadmin: superadmin,
  } as never;
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [row] = await db().insert(users).values({ email: "boss@petrosil.example", name: "Boss" }).returning();

  boss = row!.id;

  await db().insert(memberships).values([
    { userId: boss, siteId: baseoil.siteId, role: "superadmin" },
    { userId: boss, siteId: bitumart.siteId, role: "superadmin" },
  ]);
});

async function role(name: string, permissions: string[]) {
  const saved = await saveRole(await viewer(boss), { name, permissions });

  return (saved as { id: number }).id;
}

describe("inviting staff", () => {
  it("creates the account, grants the brand, and hands back a link to set a password", async () => {
    const result = await grantStaff(await viewer(boss), {
      email: "Editor@Petrosil.example",
      name: "An Editor",
      grants: [{ site: "baseoil", roleId: null }],
    });

    expect(result.ok).toBe(true);

    const { userId, inviteUrl } = result as { userId: number; inviteUrl: string | null };
    const [person] = await db().select().from(users).where(eq(users.id, userId));

    expect(person!.email).toBe("editor@petrosil.example");

    const [grant] = await db().select().from(memberships).where(eq(memberships.userId, userId));

    expect(grant).toMatchObject({ siteId: baseoil.siteId, role: "staff", roleId: null });

    // The link is mailed, and shown once: mail does not leave a laptop.
    expect(inviteUrl).toMatch(/\/set-password\?token=/);

    const [mail] = await db().select().from(mailOutbox);

    expect(mail).toMatchObject({ to: "editor@petrosil.example", template: "staff_invite" });

    // Spending the link sets the password, and the person can sign in.
    const token = new URL(inviteUrl!).searchParams.get("token")!;

    expect(await acceptStaffInvite(token, "a-long-pass-1")).toEqual({ ok: true });
    expect(await acceptStaffInvite(token, "a-long-pass-2")).toMatchObject({ ok: false });

    const login = await loginRoute(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "editor@petrosil.example", password: "a-long-pass-1" }),
      }),
    );

    expect(login.status).toBe(200);
  });

  it("makes an existing reader staff without touching what they subscribe to", async () => {
    const [reader] = await db()
      .insert(users)
      .values({ email: "reader@company.example", name: "Reader", passwordHash: await hashPassword("x-password-1") })
      .returning();
    await db().insert(memberships).values({ userId: reader!.id, siteId: baseoil.siteId, role: "subscriber", tier: "premium", expiresAt: "2027-01-01" });

    const result = await grantStaff(await viewer(boss), {
      email: "reader@company.example",
      name: "Reader",
      grants: [{ site: "baseoil", roleId: null }],
    });

    expect(result).toMatchObject({ ok: true, inviteUrl: null });

    const [grant] = await db().select().from(memberships).where(eq(memberships.userId, reader!.id));

    expect(grant).toMatchObject({ role: "staff", tier: "premium", expiresAt: "2027-01-01" });
  });

  it("is for superadmins only", async () => {
    const staffer = await grantStaff(await viewer(boss), { email: "s@petrosil.example", name: "S", grants: [{ site: "baseoil", roleId: null }] });
    const id = (staffer as { userId: number }).userId;

    const result = await grantStaff(await viewer(id), { email: "friend@x.example", name: "F", grants: [{ site: "baseoil", roleId: null }] });

    expect(result.ok).toBe(false);
  });

  it("gives a named role on one brand", async () => {
    const editor = await role("Content editor", ["article-create", "article-edit"]);

    const result = await grantStaff(await viewer(boss), {
      email: "e@petrosil.example",
      name: "E",
      grants: [{ site: "bitumart", roleId: editor }],
    });
    const [grant] = await db().select().from(memberships).where(eq(memberships.userId, (result as { userId: number }).userId));

    expect(grant).toMatchObject({ siteId: bitumart.siteId, roleId: editor });
  });
});

describe("taking access away", () => {
  it("returns a staff member to an ordinary reader of that brand", async () => {
    const staffer = await grantStaff(await viewer(boss), { email: "s@petrosil.example", name: "S", grants: [{ site: "baseoil", roleId: null }] });
    const id = (staffer as { userId: number }).userId;

    expect((await revokeStaff(await viewer(boss), id, "baseoil")).ok).toBe(true);

    const [grant] = await db().select().from(memberships).where(eq(memberships.userId, id));

    expect(grant).toMatchObject({ role: "subscriber", roleId: null });
    expect(await db().select().from(auditLog).where(eq(auditLog.action, "staff.revoke"))).toHaveLength(1);
  });

  it("never removes the last superadmin", async () => {
    const result = await revokeStaff(await viewer(boss), boss, "all");

    expect(result.ok).toBe(false);
  });

  it("can make a second superadmin, who then may remove the first", async () => {
    const staffer = await grantStaff(await viewer(boss), { email: "s@petrosil.example", name: "S", grants: [{ site: "baseoil", roleId: null }] });
    const id = (staffer as { userId: number }).userId;

    expect((await makeSuperadmin(await viewer(boss), id)).ok).toBe(true);

    const grants = await db().select().from(memberships).where(eq(memberships.userId, id));

    expect(grants.map((g) => g.role).sort()).toEqual(["superadmin", "superadmin"]);
    expect((await revokeStaff(await viewer(id), boss, "all")).ok).toBe(true);
  });
});

describe("roles", () => {
  it("saves a role with the permissions ticked, and replaces them on edit", async () => {
    const id = await role("Office staff", ["article-create", "announcement-edit"]);

    await saveRole(await viewer(boss), { id, name: "Office staff", permissions: ["article-edit"] });

    const granted = await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, id));

    expect(granted.map((g) => g.permission)).toEqual(["article-edit"]);
  });

  it("refuses a permission nothing checks, and a name already taken", async () => {
    await role("Office staff", []);

    expect((await saveRole(await viewer(boss), { name: "Ghost", permissions: ["product-delete"] })).ok).toBe(false);
    expect((await saveRole(await viewer(boss), { name: "office STAFF", permissions: [] })).ok).toBe(false);
  });

  it("will not delete a role someone holds", async () => {
    const id = await role("Held", ["article-create"]);
    await grantStaff(await viewer(boss), { email: "h@petrosil.example", name: "H", grants: [{ site: "baseoil", roleId: id }] });

    expect((await deleteRole(await viewer(boss), id)).ok).toBe(false);

    const free = await role("Free", []);

    expect((await deleteRole(await viewer(boss), free)).ok).toBe(true);
    expect(await db().select().from(roles).where(eq(roles.id, free))).toHaveLength(0);
  });
});

describe("what a person may do", () => {
  it("lets a superadmin do anything, and plain staff anything on their own brands only", async () => {
    const plain = await grantStaff(await viewer(boss), { email: "p@petrosil.example", name: "P", grants: [{ site: "baseoil", roleId: null }] });
    const id = (plain as { userId: number }).userId;

    expect(await can(await viewer(boss), bitumart.siteId, "setting-edit")).toBe(true);
    expect(await can(await viewer(id), baseoil.siteId, "setting-edit")).toBe(true);
    expect(await can(await viewer(id), bitumart.siteId, "article-create")).toBe(false);
  });

  it("holds a role to exactly what it grants", async () => {
    const writer = await role("Writer", ["announcement-create", "announcement-edit"]);
    const made = await grantStaff(await viewer(boss), { email: "w@petrosil.example", name: "W", grants: [{ site: "baseoil", roleId: writer }] });
    const me = await viewer((made as { userId: number }).userId);

    expect(await can(me, baseoil.siteId, "announcement-create")).toBe(true);
    expect(await can(me, baseoil.siteId, "setting-edit")).toBe(false);
    await expect(requirePermission(me, baseoil.siteId, "setting-edit")).rejects.toBeInstanceOf(AccessError);
  });

  it("comes back to a form as a message, not an error page", async () => {
    const writer = await role("Writer", ["announcement-create"]);
    const made = await grantStaff(await viewer(boss), { email: "w@petrosil.example", name: "W", grants: [{ site: "baseoil", roleId: writer }] });
    const me = await viewer((made as { userId: number }).userId);

    expect(await orRefused(requirePermission(me, baseoil.siteId, "report-send"))).toEqual({
      ok: false,
      message: "Your role does not allow this: send a report or a sample.",
    });
    // Anything that is not a refusal still fails loudly.
    await expect(orRefused(Promise.reject(new Error("database down")))).rejects.toThrow("database down");
  });

  it("is checked where the work is done, not only on the screen", async () => {
    const reader = await role("Reader only", ["article-list"]);
    const made = await grantStaff(await viewer(boss), { email: "r@petrosil.example", name: "R", grants: [{ site: "baseoil", roleId: reader }] });
    const me = await viewer((made as { userId: number }).userId);

    await expect(
      saveAnnouncement(me, { site: "baseoil", body: "Sneaky notice" }),
    ).rejects.toBeInstanceOf(AccessError);

    const [notice] = await db().select().from(memberships).where(and(eq(memberships.userId, (made as { userId: number }).userId)));

    expect(notice!.roleId).toBe(reader);
  });
});
