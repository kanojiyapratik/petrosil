/**
 * The published price note: the paragraph the price module's AI writes
 * about an update, shown above the brand's price table.
 *
 * Staff see the note readers see now and the ones before it, correct one's
 * wording, remove a bad one (the site then shows the one before), and write
 * one by hand when the module sent none. The AI's own text is kept in the
 * audit trail whenever staff change it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, priceSummaries, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { insightsFor } from "@/domain/public/insights";
import { correctNote, listNotes, removeNote, writeNote } from "@/domain/price/notes";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;
let older: number;
let latest: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;

  const [a] = await db()
    .insert(priceSummaries)
    .values({ siteId: baseoil.siteId, summary: "Last week: steady.", createdAt: new Date("2026-10-20T10:00:00Z") })
    .returning();
  const [b] = await db()
    .insert(priceSummaries)
    .values({ siteId: baseoil.siteId, summary: "Asian marker firmer by USD 1O/MT.", createdAt: new Date("2026-10-27T10:00:00Z") })
    .returning();

  older = a!.id;
  latest = b!.id;
});

describe("the price notes", () => {
  it("lists a brand's notes newest first, the first being the one on the site", async () => {
    const notes = await listNotes([], "baseoil");

    expect(notes.map((note) => note.id)).toEqual([latest, older]);
    expect(notes[0]!.live).toBe(true);
    expect(notes[1]!.live).toBe(false);
  });

  it("corrects a note's wording, keeping the AI's text in the trail", async () => {
    await correctNote(guard([]), latest, { summary: "Asian marker firmer by USD 10/MT." });

    expect((await insightsFor(baseoil.siteId)).latest!.summary).toBe("Asian marker firmer by USD 10/MT.");

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "price-note.correct"));

    expect(entry!.detail).toMatchObject({ was: "Asian marker firmer by USD 1O/MT." });
  });

  it("removes a bad note, so the site shows the one before", async () => {
    expect(await removeNote(guard([]), latest)).toBe(true);
    expect((await insightsFor(baseoil.siteId)).latest!.id).toBe(older);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "price-note.remove"));

    expect(entry!.detail).toMatchObject({ summary: "Asian marker firmer by USD 1O/MT." });
  });

  it("takes a note written by hand, which goes straight to the top", async () => {
    const made = await writeNote(guard([]), { site: "baseoil", summary: "Markets closed for Diwali; no assessment this week." });

    const [row] = await db().select().from(priceSummaries).where(eq(priceSummaries.id, made.id));

    expect(row).toMatchObject({ source: "staff", siteId: baseoil.siteId });
    expect((await insightsFor(baseoil.siteId)).latest!.id).toBe(made.id);
  });

  it("refuses an empty note", async () => {
    await expect(correctNote(guard([]), latest, { summary: "  " })).rejects.toMatchObject({ field: "summary" });
    await expect(writeNote(guard([]), { site: "baseoil", summary: "" })).rejects.toMatchObject({ field: "summary" });
  });

  it("is not another brand's staff's, nor a role's without the note permission", async () => {
    expect(await removeNote(guard([bitumart.siteId]), latest)).toBe(false);
    expect(await correctNote(guard([bitumart.siteId]), latest, { summary: "Mine" })).toBeNull();

    const [role] = await db().insert(roles).values({ name: "Prices" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-view" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(correctNote(guard([baseoil.siteId]), latest, { summary: "X" })).rejects.toBeInstanceOf(AccessError);
  });
});
