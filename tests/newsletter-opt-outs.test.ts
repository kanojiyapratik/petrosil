/**
 * The staff screen for who is off a brand's newsletter: listing, taking an
 * address off by hand, and putting one back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, newsletterOptOuts, newsletters, rolePermissions, roles, users } from "@/db/schema";
import { addOptOut, listOptOuts, removeOptOut } from "@/domain/content/newsletter-opt-outs";
import { audienceCounts } from "@/domain/content/newsletter-send";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let editor: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: editor }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

async function staffWith(permissions: string[]) {
  const [role] = await db().insert(roles).values({ name: "Limited" }).returning();

  if (permissions.length) {
    await db().insert(rolePermissions).values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  await db().insert(memberships).values({ userId: editor, siteId: baseoil.siteId, role: "staff", roleId: role!.id });
}

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [row] = await db()
    .insert(users)
    .values({ email: "editor@petrosil.example", name: "An Editor", passwordHash: "x" })
    .returning();

  editor = row!.id;
});

describe("the list", () => {
  it("shows this brand's opt-outs newest first, with the member's name, filtered and searched", async () => {
    const [member] = await db()
      .insert(users)
      .values({ email: "Asha@Buyer.example", name: "Asha Rao", status: "active" })
      .returning();
    await db().insert(memberships).values({ userId: member!.id, siteId: baseoil.siteId, role: "subscriber", tier: "free" });

    await db().insert(newsletterOptOuts).values([
      { siteId: baseoil.siteId, email: "asha@buyer.example", source: "link", createdAt: new Date("2026-11-01") },
      { siteId: baseoil.siteId, email: "old@gone.example", source: "staff", createdAt: new Date("2026-11-10") },
      { siteId: bitumart.siteId, email: "other@brand.example", source: "link" },
    ]);

    const all = await listOptOuts(guard([baseoil.siteId]), { site: "baseoil" });

    expect(all!.total).toBe(2);
    expect(all!.rows.map((row) => row.email)).toEqual(["old@gone.example", "asha@buyer.example"]);
    expect(all!.rows[1]).toMatchObject({ name: "Asha Rao", userId: member!.id });
    expect(all!.rows[0]).toMatchObject({ name: null, userId: null });

    const links = await listOptOuts(guard([baseoil.siteId]), { site: "baseoil", source: "link" });
    expect(links!.rows.map((row) => row.email)).toEqual(["asha@buyer.example"]);

    const searched = await listOptOuts(guard([baseoil.siteId]), { site: "baseoil", q: "GONE" });
    expect(searched!.rows.map((row) => row.email)).toEqual(["old@gone.example"]);
  });

  it("answers another brand's list as if it did not exist", async () => {
    expect(await listOptOuts(guard([bitumart.siteId]), { site: "baseoil" })).toBeNull();
  });
});

describe("taking someone off", () => {
  it("adds the address lowercased as a staff opt-out, leaves it out of the next send, and audits it", async () => {
    const [member] = await db()
      .insert(users)
      .values({ email: "Buyer@Firm.example", name: "Buyer", status: "active" })
      .returning();
    await db().insert(memberships).values({ userId: member!.id, siteId: baseoil.siteId, role: "subscriber", tier: "free" });
    const [issue] = await db()
      .insert(newsletters)
      .values({ siteId: baseoil.siteId, title: "W", body: "<p>x</p>", status: "draft" })
      .returning();

    expect((await audienceCounts(guard([baseoil.siteId]), issue!.id))!.everyone).toBe(1);

    const result = await addOptOut(guard([baseoil.siteId]), { site: "baseoil", email: "  BUYER@firm.example " });

    expect(result.ok).toBe(true);
    const [row] = await db().select().from(newsletterOptOuts);
    expect(row).toMatchObject({ email: "buyer@firm.example", source: "staff", siteId: baseoil.siteId });
    expect((await audienceCounts(guard([baseoil.siteId]), issue!.id))!.everyone).toBe(0);

    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, "newsletter.opt_out"));
    expect(audit).toBeDefined();
  });

  it("refuses a bad address and one already off", async () => {
    expect((await addOptOut(guard([baseoil.siteId]), { site: "baseoil", email: "nope" })).ok).toBe(false);

    await addOptOut(guard([baseoil.siteId]), { site: "baseoil", email: "a@b.example" });
    const again = await addOptOut(guard([baseoil.siteId]), { site: "baseoil", email: "A@B.example" });

    expect(again).toEqual({ ok: false, message: expect.stringMatching(/already off/) });
  });

  it("needs newsletter-edit", async () => {
    await staffWith(["newsletter-list"]);

    await expect(addOptOut(guard([baseoil.siteId]), { site: "baseoil", email: "a@b.example" })).rejects.toThrow();
  });
});

describe("putting someone back", () => {
  it("removes the opt-out and audits what kind it was", async () => {
    const [row] = await db()
      .insert(newsletterOptOuts)
      .values({ siteId: baseoil.siteId, email: "back@firm.example", source: "link" })
      .returning();

    const result = await removeOptOut(guard([baseoil.siteId]), { site: "baseoil", id: row!.id });

    expect(result.ok).toBe(true);
    expect(await db().select().from(newsletterOptOuts)).toHaveLength(0);
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, "newsletter.opt_in"));
    expect(audit!.detail).toMatchObject({ email: "back@firm.example", was: "link" });
  });

  it("cannot reach another brand's opt-out through this brand", async () => {
    const [row] = await db()
      .insert(newsletterOptOuts)
      .values({ siteId: bitumart.siteId, email: "x@y.example", source: "link" })
      .returning();

    const result = await removeOptOut(guard([baseoil.siteId, bitumart.siteId]), { site: "baseoil", id: row!.id });

    expect(result.ok).toBe(false);
    expect(await db().select().from(newsletterOptOuts)).toHaveLength(1);
  });

  it("needs newsletter-send, not just newsletter-edit", async () => {
    const [row] = await db()
      .insert(newsletterOptOuts)
      .values({ siteId: baseoil.siteId, email: "x@y.example", source: "link" })
      .returning();
    await staffWith(["newsletter-list", "newsletter-edit"]);

    await expect(removeOptOut(guard([baseoil.siteId]), { site: "baseoil", id: row!.id })).rejects.toThrow(
      /send a newsletter/i,
    );
  });
});
