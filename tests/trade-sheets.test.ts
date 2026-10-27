/**
 * Entering monthly import and export quantities.
 *
 * The old admin's way, kept: pick a reporting country and a month, and type a
 * quantity against each partner country on one sheet. An export runs from the
 * reporting country to each partner; an import runs from each partner into
 * the reporting country. The price module never covered these, so this is
 * the only way they get entered once the old admins go.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, rolePermissions, roles, tradeLocations, tradeQuantities, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { clearSheet, monthsFor, saveSheet, saveTradePlace, sheetFor } from "@/domain/trade/sheets";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;
let india: number;
let uae: number;
let singapore: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", []);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
  india = (await saveTradePlace(guard([]), { site: "baseoil", title: "India", visible: true }))!.id;
  uae = (await saveTradePlace(guard([]), { site: "baseoil", title: "UAE", visible: true }))!.id;
  singapore = (await saveTradePlace(guard([]), { site: "baseoil", title: "Singapore", visible: true }))!.id;
});

const cells = (kind: string) =>
  db()
    .select()
    .from(tradeQuantities)
    .where(and(eq(tradeQuantities.siteId, baseoil.siteId), eq(tradeQuantities.kind, kind as never)));

describe("a month's export sheet", () => {
  it("records each partner's quantity as a flow from the reporting country", async () => {
    const result = await saveSheet(guard([]), {
      site: "baseoil",
      kind: "export",
      location: india,
      date: "2026-09-01",
      quantities: { [uae]: "1,250.5", [singapore]: "300" },
    });

    expect(result).toEqual({ saved: 2, cleared: 0 });

    const rows = await cells("export");

    expect(rows.map((row) => [row.fromLocationId, row.toLocationId, row.qty, row.qtyDate]).sort()).toEqual(
      [
        [india, uae, "1250.500", "2026-09-01"],
        [india, singapore, "300.000", "2026-09-01"],
      ].sort(),
    );

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "trade.sheet"));

    expect(entry!.detail).toMatchObject({ kind: "export", location: "India", date: "2026-09-01", saved: 2 });
  });

  it("changes a number in place and clears a box that is emptied", async () => {
    await saveSheet(guard([]), { site: "baseoil", kind: "export", location: india, date: "2026-09-01", quantities: { [uae]: "100", [singapore]: "50" } });

    const result = await saveSheet(guard([]), {
      site: "baseoil",
      kind: "export",
      location: india,
      date: "2026-09-01",
      quantities: { [uae]: "120", [singapore]: "" },
    });

    expect(result).toEqual({ saved: 1, cleared: 1 });

    const rows = await cells("export");

    expect(rows.map((row) => [row.toLocationId, row.qty])).toEqual([[uae, "120.000"]]);
  });

  it("is shown with every partner, the reporting country left out", async () => {
    await saveSheet(guard([]), { site: "baseoil", kind: "export", location: india, date: "2026-09-01", quantities: { [uae]: "100" } });

    const sheet = await sheetFor([], { site: "baseoil", kind: "export", location: india, date: "2026-09-01" });

    expect(sheet!.location).toMatchObject({ id: india, title: "India" });
    expect(sheet!.rows.map((row) => [row.title, row.qty])).toEqual([
      ["Singapore", null],
      ["UAE", "100.000"],
    ]);
    expect(sheet!.total).toBe(100);
  });
});

describe("a month's import sheet", () => {
  it("records each partner's quantity as a flow into the reporting country", async () => {
    await saveSheet(guard([]), { site: "baseoil", kind: "import", location: india, date: "2026-09-01", quantities: { [uae]: "75" } });

    const [row] = await cells("import");

    expect([row!.fromLocationId, row!.toLocationId]).toEqual([uae, india]);
    expect((await sheetFor([], { site: "baseoil", kind: "import", location: india, date: "2026-09-01" }))!.rows).toContainEqual({
      id: uae,
      title: "UAE",
      qty: "75.000",
    });
  });
});

describe("the months on record", () => {
  it("lists a reporting country's months newest first, with their totals", async () => {
    await saveSheet(guard([]), { site: "baseoil", kind: "export", location: india, date: "2026-08-01", quantities: { [uae]: "10", [singapore]: "5" } });
    await saveSheet(guard([]), { site: "baseoil", kind: "export", location: india, date: "2026-09-01", quantities: { [uae]: "20" } });
    // Another reporting country's months are not India's.
    await saveSheet(guard([]), { site: "baseoil", kind: "export", location: uae, date: "2026-10-01", quantities: { [india]: "1" } });

    expect(await monthsFor([], { site: "baseoil", kind: "export", location: india })).toEqual([
      { date: "2026-09-01", total: 20, partners: 1 },
      { date: "2026-08-01", total: 15, partners: 2 },
    ]);
  });

  it("clears a whole month", async () => {
    await saveSheet(guard([]), { site: "baseoil", kind: "export", location: india, date: "2026-09-01", quantities: { [uae]: "10", [singapore]: "5" } });

    expect(await clearSheet(guard([]), { site: "baseoil", kind: "export", location: india, date: "2026-09-01" })).toBe(2);
    expect(await cells("export")).toEqual([]);
  });
});

describe("what a sheet refuses", () => {
  it("a quantity that is not a number, a month that does not exist, and an unknown kind", async () => {
    const base = { site: "baseoil", kind: "export", location: india, date: "2026-09-01" };

    await expect(saveSheet(guard([]), { ...base, quantities: { [uae]: "lots" } })).rejects.toMatchObject({ field: "quantities" });
    await expect(saveSheet(guard([]), { ...base, quantities: { [uae]: "-5" } })).rejects.toMatchObject({ field: "quantities" });
    await expect(saveSheet(guard([]), { ...base, date: "2026-13-01", quantities: {} })).rejects.toMatchObject({ field: "date" });
    await expect(saveSheet(guard([]), { ...base, kind: "smuggled", quantities: {} })).rejects.toMatchObject({ field: "kind" });
  });

  it("another brand's places, as reporting country or partner", async () => {
    const theirs = (await saveTradePlace(guard([]), { site: "bitumart", title: "Iran", visible: true }))!.id;
    const base = { site: "baseoil", kind: "export", date: "2026-09-01" };

    await expect(saveSheet(guard([]), { ...base, location: theirs, quantities: {} })).rejects.toMatchObject({ field: "location" });
    await expect(saveSheet(guard([]), { ...base, location: india, quantities: { [theirs]: "5" } })).rejects.toMatchObject({
      field: "quantities",
    });
  });

  it("staff of another brand, and a role without the quantities permission", async () => {
    const base = { site: "baseoil", kind: "export", location: india, date: "2026-09-01", quantities: { [uae]: "5" } };

    await expect(saveSheet(guard([bitumart.siteId]), base)).rejects.toMatchObject({ status: 403 });

    const [role] = await db().insert(roles).values({ name: "Reader" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "article-create" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(saveSheet(guard([baseoil.siteId]), base)).rejects.toBeInstanceOf(AccessError);
  });
});

describe("a trade place", () => {
  it("is renamed and hidden, but never given a name the brand already has", async () => {
    await expect(saveTradePlace(guard([]), { site: "baseoil", title: "india", visible: true })).rejects.toMatchObject({
      field: "title",
      status: 409,
    });

    const saved = await saveTradePlace(guard([]), { id: uae, title: "United Arab Emirates", visible: false });

    expect(saved).toMatchObject({ title: "United Arab Emirates", visible: false });

    const [row] = await db().select().from(tradeLocations).where(eq(tradeLocations.id, uae));

    expect(row).toMatchObject({ title: "United Arab Emirates", visible: false });
  });
});
