/**
 * Staff correcting a member's details: the old directory editor.
 *
 * The same fields a member may change themselves, plus the address and
 * postcode the directory shows. Never the email (it is their sign-in) and
 * never their standing (that is the membership editor's). A member is staff's
 * to edit only when they read one of the staff member's brands.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { editMember } from "@/domain/clients/profile";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;
let member: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();
  const [them] = await db()
    .insert(users)
    .values({ email: "trader@gulf.example", name: "Old Name", company: "Old Co", phone: "123" })
    .returning();

  staff = me!.id;
  member = them!.id;

  await db().insert(memberships).values({ userId: member, siteId: baseoil.siteId, tier: "premium" });
});

describe("editing a member", () => {
  it("changes their name, company, contact details and address, and records what changed", async () => {
    const saved = await editMember(guard([]), member, {
      name: "Ravi Khan",
      company: "Gulf Lubes FZE",
      designation: "Buyer",
      phone: "+971 4 555 0100",
      country: "United Arab Emirates",
      city: "Dubai",
      address: "Jebel Ali Free Zone, Plot 12",
      postcode: "17000",
      website: "https://gulflubes.example",
    });

    expect(saved).toMatchObject({ name: "Ravi Khan", company: "Gulf Lubes FZE", city: "Dubai", postcode: "17000" });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "member.edit"));

    expect(entry).toMatchObject({ userId: staff, entityId: member });
    expect(entry!.detail).toMatchObject({
      changed: { name: { from: "Old Name", to: "Ravi Khan" }, company: { from: "Old Co", to: "Gulf Lubes FZE" } },
    });
  });

  it("clears a field sent blank, refuses a blank name, and never touches the email or status", async () => {
    await editMember(guard([]), member, { phone: "", email: "attacker@x.example", status: "disabled" } as never);

    const [row] = await db().select().from(users).where(eq(users.id, member));

    expect(row).toMatchObject({ phone: null, email: "trader@gulf.example", status: "active" });

    await expect(editMember(guard([]), member, { name: "  " })).rejects.toMatchObject({ field: "name" });
  });

  it("is only for staff of a brand the member reads", async () => {
    expect(await editMember(guard([bitumart.siteId]), member, { name: "Mine" })).toBeNull();
    expect(await editMember(guard([baseoil.siteId]), member, { name: "Fine" })).toMatchObject({ name: "Fine" });
  });

  it("needs user-edit when the editor holds a role", async () => {
    const [role] = await db().insert(roles).values({ name: "Viewer" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "user-list" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(editMember(guard([baseoil.siteId]), member, { name: "X" })).rejects.toBeInstanceOf(AccessError);
  });

  it("does not let brand staff edit another staff member", async () => {
    const [colleague] = await db().insert(users).values({ email: "c@petrosil.example", name: "Colleague" }).returning();

    await db().insert(memberships).values({ userId: colleague!.id, siteId: baseoil.siteId, role: "staff" });

    expect(await editMember(guard([baseoil.siteId]), colleague!.id, { name: "Renamed" })).toBeNull();
  });
});
