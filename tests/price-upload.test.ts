/**
 * Staff uploading a price sheet from the admin, and mending its rows.
 *
 * The sheet reading itself is pinned in upload-bulk.test.ts (shared with the
 * console's relay). These pin what the admin adds: who may, that the result
 * is a draft nobody published, that it is recorded, and that an unmatched
 * row can be pointed at its market without uploading the sheet again.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, memberships, priceBatchItems, priceBatches, prices, rolePermissions, roles, users } from "@/db/schema";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { editRow, marketsToPick, uploadSheet } from "@/domain/price/upload";
import { dayOffset, makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const SG = "Singapore SN 150 FOB";
const UAE = "UAE SN 500";
const TODAY = dayOffset(new Date(), 0);
const LAST_WEEK = dayOffset(new Date(), -7);

let baseoil: Brand;
let staff: number;

const guard = (siteIds: number[] = []) =>
  ({ identity: { user: { id: staff }, memberships: [] }, siteIds, isSuperadmin: siteIds.length === 0 }) as never;

const csv = (text: string) => ({ name: "prices.csv", bytes: Buffer.from(text, "utf8") });

const rowsOf = (batchId: number) => db().select().from(priceBatchItems).where(eq(priceBatchItems.batchId, batchId)).orderBy(priceBatchItems.id);

beforeEach(async () => {
  await resetDatabase();
  baseoil = await makeBrand("baseoil", [SG, UAE]);
  await makeBrand("bitumart", ["Mumbai VG30"]);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("uploading a sheet", () => {
  it("stages a draft by the uploader, publishes nothing, and records it", async () => {
    const result = await uploadSheet(guard(), "baseoil", csv(`Market,Price\n${SG},710\n${UAE},650\nNowhere SN 9,1\n`), TODAY);

    expect(result).toMatchObject({ rows: 3, needsLook: 1 });

    const [batch] = await db().select().from(priceBatches).where(eq(priceBatches.id, result.batchId));
    expect(batch).toMatchObject({ siteId: baseoil.siteId, source: "upload", status: "draft", createdBy: staff });
    expect((await rowsOf(result.batchId)).map((row) => row.status)).toEqual(["new", "new", "unmatched"]);
    expect(await db().select().from(prices)).toHaveLength(0);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "price_batch.upload"));
    expect(entry).toMatchObject({ siteId: baseoil.siteId, userId: staff, entityId: result.batchId });
    expect(entry!.detail).toMatchObject({ file: "prices.csv", rows: 3, needs_look: 1 });
  });

  it("refuses an .xls, an empty file, and a dateless sheet with no date chosen", async () => {
    await expect(uploadSheet(guard(), "baseoil", { name: "old.xls", bytes: Buffer.from("x") }, TODAY)).rejects.toThrow(/\.xlsx or \.csv/);
    await expect(uploadSheet(guard(), "baseoil", csv(""), TODAY)).rejects.toBeInstanceOf(AccountError);
    await expect(uploadSheet(guard(), "baseoil", csv(`${SG},710\n`), null)).rejects.toThrow(/choose the price date/);
    expect(await db().select().from(priceBatches)).toHaveLength(0);
  });

  it("is for staff of the brand who may stage updates", async () => {
    // Another brand only.
    const other = (await makeBrand("waxreport", ["Wax"])).siteId;
    await expect(uploadSheet(guard([other]), "baseoil", csv(`${SG},710\n`), TODAY)).rejects.toBeInstanceOf(AccountError);

    // This brand, but a role without price-batch-create.
    const [role] = await db().insert(roles).values({ name: "Reader" }).returning();
    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-view" });
    await db().insert(memberships).values({ userId: staff, siteId: baseoil.siteId, role: "staff", roleId: role!.id });
    await expect(uploadSheet(guard([baseoil.siteId]), "baseoil", csv(`${SG},710\n`), TODAY)).rejects.toBeInstanceOf(AccessError);

    await db().insert(rolePermissions).values({ roleId: role!.id, permission: "price-batch-create" });
    expect((await uploadSheet(guard([baseoil.siteId]), "baseoil", csv(`${SG},710\n`), TODAY)).rows).toBe(1);
  });
});

describe("mending a row", () => {
  it("points an unmatched row at its market, which re-diffs it, and records the change", async () => {
    const { batchId } = await uploadSheet(guard(), "baseoil", csv(`Singapore SN150,710\n`), TODAY);
    const [row] = await rowsOf(batchId);
    expect(row!.status).toBe("unmatched");

    await editRow(guard(), { site: "baseoil", itemId: row!.id, patch: { location_id: baseoil.locationIds[SG] } });

    const [after] = await rowsOf(batchId);
    expect(after).toMatchObject({ locationId: baseoil.locationIds[SG], status: "new", errorMessage: null });

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "price_batch.edit_row"));
    expect(entry!.detail).toMatchObject({ item: row!.id, status: "new", changed: { locationId: { from: null, to: baseoil.locationIds[SG] } } });
  });

  it("will not change a locked row's price, but will leave it out", async () => {
    await publishPrice(baseoil, SG, 700, LAST_WEEK);

    const { batchId } = await uploadSheet(guard(), "baseoil", csv(`${SG},${LAST_WEEK},705\n`), null);
    const [row] = await rowsOf(batchId);
    expect(row!.status).toBe("locked");

    await expect(editRow(guard(), { site: "baseoil", itemId: row!.id, patch: { new_price: "706", is_included: true } })).rejects.toThrow(
      /cannot be edited/,
    );

    await editRow(guard(), { site: "baseoil", itemId: row!.id, patch: { is_included: false } });
    expect((await rowsOf(batchId))[0]!.isIncluded).toBe(false);
  });

  it("refuses a row of another brand, and a market of another brand", async () => {
    const { batchId } = await uploadSheet(guard(), "baseoil", csv(`Singapore SN150,710\n`), TODAY);
    const [row] = await rowsOf(batchId);
    const [wrong] = await marketsToPick((await makeBrand("glycerinereport", ["Glycerine"])).siteId);

    await expect(editRow(guard(), { site: "bitumart", itemId: row!.id, patch: { is_included: false } })).rejects.toThrow(/No such row/);
    await expect(editRow(guard(), { site: "baseoil", itemId: row!.id, patch: { location_id: wrong!.id } })).rejects.toThrow(/No such location/);
  });

  it("lists the brand's markets, by name", async () => {
    expect((await marketsToPick(baseoil.siteId)).map((m) => m.title)).toEqual([SG, UAE]);
  });
});
