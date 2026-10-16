/**
 * The rules a wrong answer would cost money: which status a staged row gets,
 * what a commit writes, and what it refuses to write.
 */
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/db";
import { prices, priceBatchItems } from "@/db/schema";
import {
  BatchError,
  batchItems,
  commitBatch,
  discardBatch,
  rollbackBatch,
  stageRows,
  updateItem,
} from "@/domain/price/batches";
import { locationsWithLatestPrice } from "@/domain/price/locations";
import { dayOffset, makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const NOW = new Date(2026, 9, 16, 9, 0, 0); // 16 October 2026, local
const TODAY = "2026-10-16";
const YESTERDAY = dayOffset(NOW, -1);
const TOMORROW = dayOffset(NOW, 1);

let brand: Brand;

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand();
});

describe("staging rows", () => {
  it("marks a location with no price on that date as new", async () => {
    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    expect(items[0]!.status).toBe("new");
    expect(items[0]!.oldPrice).toBeNull();
    expect(Number(items[0]!.newPrice)).toBe(1520);
    expect(items[0]!.currency).toBe("USD");
  });

  it("marks a different price on a future date as changed, and the same price as unchanged", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, TOMORROW);

    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [
        { location: "Singapore SN 150 FOB", price: 1520, date: TOMORROW },
        { location: "Singapore SN 150 FOB", price: 1500, date: TOMORROW },
      ],
      now: NOW,
    });

    expect(items.map((i) => i.status)).toEqual(["changed", "unchanged"]);
    expect(Number(items[0]!.oldPrice)).toBe(1500);
  });

  it("locks a date that has already passed, because published history is immutable", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, YESTERDAY);

    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520, date: YESTERDAY }],
      now: NOW,
    });

    expect(items[0]!.status).toBe("locked");
  });

  it("still allows backfilling a past date that has no price", async () => {
    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520, date: YESTERDAY }],
      now: NOW,
    });

    expect(items[0]!.status).toBe("new");
  });

  it("reports an unknown name and an unreadable price per row, without failing the batch", async () => {
    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [
        { location: "Atlantis FOB", price: 100 },
        { location: "Singapore SN 150 FOB", price: "not a number" },
        { location: "Singapore SN 150 FOB", price: -5 },
        { location: "Singapore SN 150 FOB", price: 1520, date: "wednesday-ish" },
        { location: "Singapore SN 150 FOB", price: 1520 },
      ],
      priceDate: TODAY,
      now: NOW,
    });

    expect(items.map((i) => i.status)).toEqual(["unmatched", "invalid", "invalid", "invalid", "new"]);
    expect(items[0]!.errorMessage).toBe("No location matches this name.");
    expect(items[3]!.errorMessage).toBe("Could not read the date.");
  });

  it("matches a name whatever its case and spacing", async () => {
    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "  singapore   sn 150 fob ", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    expect(items[0]!.status).toBe("new");
    expect(items[0]!.locationId).toBe(brand.locationIds["Singapore SN 150 FOB"]);
    expect(items[0]!.rawLocation).toBe("  singapore   sn 150 fob ");
  });

  it("never resolves a near miss to a location", async () => {
    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    expect(items[0]!.status).toBe("unmatched");
  });

  it("will not reach another brand's locations", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Bitumen Singapore Drum FOB", price: 830 }],
      priceDate: TODAY,
      now: NOW,
    });

    expect(items[0]!.status).toBe("unmatched");
    expect(other.siteId).not.toBe(brand.siteId);
  });
});

describe("committing", () => {
  it("inserts new rows and updates changed ones", async () => {
    await publishPrice(brand, "UAE SN 500", 1340, TOMORROW);

    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [
        { location: "Singapore SN 150 FOB", price: 1520 },
        { location: "UAE SN 500", price: 1380 },
      ],
      priceDate: TOMORROW,
      now: NOW,
    });

    const result = await commitBatch(brand.siteId, batch.id, {}, db(), NOW);

    expect(result).toEqual({ applied: 1, created: 1, conflicts: 0 });

    const live = await locationsWithLatestPrice(brand.siteId);
    expect(live.map((l) => [l.title, l.latest_price])).toEqual([
      ["Singapore SN 150 FOB", 1520],
      ["UAE SN 500", 1380],
    ]);
  });

  it("refuses while an included row still needs attention", async () => {
    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Atlantis FOB", price: 100 }],
      priceDate: TODAY,
      now: NOW,
    });

    await expect(commitBatch(brand.siteId, batch.id, {}, db(), NOW)).rejects.toThrow(BatchError);
  });

  it("commits once the row that needed attention is excluded", async () => {
    const { batch, items } = await stageRows({
      siteId: brand.siteId,
      rows: [
        { location: "Atlantis FOB", price: 100 },
        { location: "Singapore SN 150 FOB", price: 1520 },
      ],
      priceDate: TODAY,
      now: NOW,
    });

    await updateItem(brand.siteId, items[0]!.id, { is_included: false }, db(), NOW);

    expect(await commitBatch(brand.siteId, batch.id, {}, db(), NOW)).toEqual({
      applied: 0,
      created: 1,
      conflicts: 0,
    });
  });

  it("reports a conflict instead of overwriting a price that moved after staging", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, TOMORROW);

    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520, date: TOMORROW }],
      now: NOW,
    });

    // Someone edits the live price between staging and commit.
    await db()
      .update(prices)
      .set({ price: "1510" })
      .where(
        and(
          eq(prices.locationId, brand.locationIds["Singapore SN 150 FOB"]!),
          eq(prices.priceDate, TOMORROW),
        ),
      );

    expect(await commitBatch(brand.siteId, batch.id, {}, db(), NOW)).toEqual({
      applied: 0,
      created: 0,
      conflicts: 1,
    });

    const [live] = await db()
      .select()
      .from(prices)
      .where(eq(prices.locationId, brand.locationIds["Singapore SN 150 FOB"]!));

    expect(Number(live!.price)).toBe(1510);

    const [item] = await batchItems(batch.id);
    expect(item!.status).toBe("conflict");
  });

  it("will not insert twice when a price appears for that date after staging", async () => {
    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TOMORROW,
      now: NOW,
    });

    await publishPrice(brand, "Singapore SN 150 FOB", 1499, TOMORROW);

    expect(await commitBatch(brand.siteId, batch.id, {}, db(), NOW)).toEqual({
      applied: 0,
      created: 0,
      conflicts: 1,
    });
  });

  it("re-derives the date lock at commit time, not from staging", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1500, TODAY);

    const { batch, items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520, date: TODAY }],
      now: NOW,
    });

    expect(items[0]!.status).toBe("changed");

    // Midnight passes before anyone commits: that date is published history now.
    const tomorrowMorning = new Date(2026, 9, 17, 9, 0, 0);

    expect(await commitBatch(brand.siteId, batch.id, {}, db(), tomorrowMorning)).toEqual({
      applied: 0,
      created: 0,
      conflicts: 1,
    });

    const [item] = await batchItems(batch.id);
    expect(item!.status).toBe("locked");

    const [live] = await db()
      .select()
      .from(prices)
      .where(eq(prices.locationId, brand.locationIds["Singapore SN 150 FOB"]!));
    expect(Number(live!.price)).toBe(1500);
  });

  it("can only be committed once", async () => {
    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    await commitBatch(brand.siteId, batch.id, {}, db(), NOW);

    await expect(commitBatch(brand.siteId, batch.id, {}, db(), NOW)).rejects.toThrow(
      "Only a draft batch can be committed.",
    );
  });

  it("cannot be committed through another brand's id", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    await expect(commitBatch(other.siteId, batch.id, {}, db(), NOW)).rejects.toThrow("No such batch.");
  });
});

describe("rollback and discard", () => {
  it("removes what it created and restores what it changed", async () => {
    await publishPrice(brand, "UAE SN 500", 1340, TOMORROW);

    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [
        { location: "Singapore SN 150 FOB", price: 1520 },
        { location: "UAE SN 500", price: 1380 },
      ],
      priceDate: TOMORROW,
      now: NOW,
    });

    await commitBatch(brand.siteId, batch.id, {}, db(), NOW);

    expect(await rollbackBatch(brand.siteId, batch.id)).toEqual({
      reverted: 1,
      removed: 1,
      skipped: 0,
    });

    const live = await locationsWithLatestPrice(brand.siteId);
    expect(live.map((l) => [l.title, l.latest_price])).toEqual([
      ["Singapore SN 150 FOB", null],
      ["UAE SN 500", 1340],
    ]);
  });

  it("leaves a price alone when someone changed it after the commit", async () => {
    await publishPrice(brand, "UAE SN 500", 1340, TOMORROW);

    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "UAE SN 500", price: 1380 }],
      priceDate: TOMORROW,
      now: NOW,
    });

    await commitBatch(brand.siteId, batch.id, {}, db(), NOW);

    await db()
      .update(prices)
      .set({ price: "1399" })
      .where(eq(prices.locationId, brand.locationIds["UAE SN 500"]!));

    expect(await rollbackBatch(brand.siteId, batch.id)).toEqual({
      reverted: 0,
      removed: 0,
      skipped: 1,
    });
  });

  it("frees the date for a new price after rolling back an insert", async () => {
    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TOMORROW,
      now: NOW,
    });

    await commitBatch(brand.siteId, batch.id, {}, db(), NOW);
    await rollbackBatch(brand.siteId, batch.id);

    const second = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1530 }],
      priceDate: TOMORROW,
      now: NOW,
    });

    expect(second.items[0]!.status).toBe("new");
    expect(await commitBatch(brand.siteId, second.batch.id, {}, db(), NOW)).toEqual({
      applied: 0,
      created: 1,
      conflicts: 0,
    });

    const live = await db()
      .select()
      .from(prices)
      .where(
        and(
          eq(prices.locationId, brand.locationIds["Singapore SN 150 FOB"]!),
          isNull(prices.deletedAt),
        ),
      );

    expect(live).toHaveLength(1);
    expect(Number(live[0]!.price)).toBe(1530);
  });

  it("discards a draft and refuses to discard anything else", async () => {
    const { batch } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    expect((await discardBatch(brand.siteId, batch.id)).status).toBe("discarded");
    await expect(discardBatch(brand.siteId, batch.id)).rejects.toThrow(
      "Only a draft batch can be discarded.",
    );
  });
});

describe("editing a staged row", () => {
  it("re-runs the diff when the price changes", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1520, TOMORROW);

    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1540, date: TOMORROW }],
      now: NOW,
    });

    expect(items[0]!.status).toBe("changed");

    const updated = await updateItem(brand.siteId, items[0]!.id, { new_price: 1520 }, db(), NOW);

    // Edited back to what is already published: the row now has nothing to do.
    expect(updated.status).toBe("unchanged");
    expect(Number(updated.oldPrice)).toBe(1520);
  });

  it("refuses a value edit on a row that has nothing to change", async () => {
    await publishPrice(brand, "Singapore SN 150 FOB", 1520, TOMORROW);

    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520, date: TOMORROW }],
      now: NOW,
    });

    expect(items[0]!.status).toBe("unchanged");

    // Same rule as the Laravel sites, in their API and their own screens:
    // only changed / new / ambiguous / unmatched rows take a value edit.
    await expect(
      updateItem(brand.siteId, items[0]!.id, { new_price: 1555 }, db(), NOW),
    ).rejects.toThrow("That row cannot be edited.");
  });

  it("resolves an unmatched row when an editor names the location", async () => {
    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapur SN150", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    expect(items[0]!.status).toBe("unmatched");

    const updated = await updateItem(
      brand.siteId,
      items[0]!.id,
      { location_id: brand.locationIds["Singapore SN 150 FOB"] },
      db(),
      NOW,
    );

    expect(updated.status).toBe("new");
    expect(updated.errorMessage).toBeNull();
    expect(updated.rawLocation).toBe("Singapur SN150");
  });

  it("refuses a location from another brand", async () => {
    const other = await makeBrand("bitumart", ["Bitumen Singapore Drum FOB"]);

    const { items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    await expect(
      updateItem(
        brand.siteId,
        items[0]!.id,
        { location_id: other.locationIds["Bitumen Singapore Drum FOB"] },
        db(),
        NOW,
      ),
    ).rejects.toThrow("No such location on this site.");
  });

  it("will not edit a row of a committed batch", async () => {
    const { batch, items } = await stageRows({
      siteId: brand.siteId,
      rows: [{ location: "Singapore SN 150 FOB", price: 1520 }],
      priceDate: TODAY,
      now: NOW,
    });

    await commitBatch(brand.siteId, batch.id, {}, db(), NOW);

    await expect(
      updateItem(brand.siteId, items[0]!.id, { new_price: 1600 }, db(), NOW),
    ).rejects.toThrow("Only a draft batch can be edited.");

    const [row] = await db()
      .select()
      .from(priceBatchItems)
      .where(eq(priceBatchItems.id, items[0]!.id));
    expect(Number(row!.newPrice)).toBe(1520);
  });
});
