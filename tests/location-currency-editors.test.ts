/**
 * Adding and renaming a brand's price locations, and the estate's currencies.
 *
 * A location's name is how the price module, the crawler and the upload
 * spreadsheets find it: names are matched with case and spacing ignored, so
 * two locations whose names differ only that way would make every price for
 * either one ambiguous. New and renamed locations are refused that.
 *
 * Currencies are shared by every brand, so only a superadmin changes them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, currencies, locations, memberships, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { saveLocation } from "@/domain/dashboard/locations";
import { saveCurrency } from "@/domain/billing/currencies";
import { LocationResolver } from "@/domain/price/locations";
import { makeBrand, resetDatabase, type Brand } from "./helpers";

let baseoil: Brand;
let bitumart: Brand;
let staff: number;

const guard = (siteIds: number[]) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", ["Singapore SN 150 FOB"]);
  bitumart = await makeBrand("bitumart", []);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;

  await db()
    .insert(currencies)
    .values([
      { code: "INR", title: "Indian Rupee", symbol: "₹" },
      { code: "USD", title: "US Dollar", symbol: "$" },
      { code: "EUR", title: "Euro", symbol: "€", enabled: false },
    ]);
});

describe("a price location", () => {
  it("is added with its currency and unit, and the price module finds it by name", async () => {
    const made = await saveLocation(guard([]), {
      site: "baseoil",
      title: "Mumbai SN 500 Ex-Tank",
      currency: "INR",
      unit: "KL",
      visible: true,
    });

    const [row] = await db().select().from(locations).where(eq(locations.id, made!.id));

    expect(row).toMatchObject({ title: "Mumbai SN 500 Ex-Tank", currency: "INR", unit: "KL", visible: true });

    const resolver = await LocationResolver.forSite(baseoil.siteId);

    expect(resolver.resolve("mumbai  sn 500 ex-tank")).toMatchObject({ status: "matched" });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "location.create"));

    expect(entry).toMatchObject({ siteId: baseoil.siteId, entityId: made!.id });
  });

  it("refuses a name that differs from another only in case or spacing", async () => {
    await expect(
      saveLocation(guard([]), { site: "baseoil", title: "singapore  SN 150 fob", currency: "USD", visible: true }),
    ).rejects.toMatchObject({ field: "title", status: 409 });

    // Another brand may use it.
    await expect(
      saveLocation(guard([]), { site: "bitumart", title: "Singapore SN 150 FOB", currency: "USD", visible: true }),
    ).resolves.not.toBeNull();
  });

  it("is renamed and its currency changed, with the old name in the trail", async () => {
    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;

    const saved = await saveLocation(guard([]), { id, title: "Singapore SN 150 FOB Bulk", currency: "USD", unit: "MT", visible: false });

    expect(saved).toMatchObject({ title: "Singapore SN 150 FOB Bulk", unit: "MT", visible: false });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "location.update"));

    expect(entry!.detail).toMatchObject({ renamed: { from: "Singapore SN 150 FOB", to: "Singapore SN 150 FOB Bulk" } });
  });

  it("refuses a currency that is not switched on", async () => {
    await expect(
      saveLocation(guard([]), { site: "baseoil", title: "Rotterdam", currency: "EUR", visible: true }),
    ).rejects.toMatchObject({ field: "currency" });
  });

  it("is not another brand's staff's, nor a role's without location-create", async () => {
    const id = baseoil.locationIds["Singapore SN 150 FOB"]!;

    expect(await saveLocation(guard([bitumart.siteId]), { id, title: "Mine", currency: "USD", visible: true })).toBeNull();

    const [role] = await db().insert(roles).values({ name: "Viewer" }).returning();

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "location-list" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });

    await expect(
      saveLocation(guard([baseoil.siteId]), { site: "baseoil", title: "New", currency: "USD", visible: true }),
    ).rejects.toBeInstanceOf(AccessError);
  });
});

describe("a currency", () => {
  it("is added and changed by a superadmin, code upper-cased", async () => {
    const made = await saveCurrency(guard([]), { code: "aed", title: "UAE Dirham", symbol: "د.إ", enabled: true });

    expect(made).toMatchObject({ code: "AED" });

    await saveCurrency(guard([]), { id: made.id, code: "AED", title: "UAE dirham", symbol: "AED", enabled: false });

    const [row] = await db().select().from(currencies).where(eq(currencies.code, "AED"));

    expect(row).toMatchObject({ title: "UAE dirham", symbol: "AED", enabled: false });
  });

  it("refuses a code already used, and anyone but a superadmin", async () => {
    await expect(saveCurrency(guard([]), { code: "usd", title: "Dollar", symbol: "$", enabled: true })).rejects.toMatchObject({
      field: "code",
      status: 409,
    });
    await expect(
      saveCurrency(guard([baseoil.siteId]), { code: "GBP", title: "Pound", symbol: "£", enabled: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("cannot be switched off while a location is priced in it", async () => {
    const [usd] = await db().select().from(currencies).where(eq(currencies.code, "USD"));

    await expect(
      saveCurrency(guard([]), { id: usd!.id, code: "USD", title: "US Dollar", symbol: "$", enabled: false }),
    ).rejects.toMatchObject({ field: "enabled", status: 409 });
  });
});
