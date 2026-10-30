/**
 * A price update's rows as the Price update page shows them: a price on a
 * date that had none is "new", and moves from the last price published.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { batchDetail } from "@/domain/dashboard/batches";
import { stageRows } from "@/domain/price/batches";
import { makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const KOREA = "Korea SN 150";
const SINGAPORE = "Singapore SN 150";
const NEW_MARKET = "Mumbai SN 150";

let brand: Brand;

beforeEach(async () => {
  await resetDatabase();
  brand = await makeBrand("baseoil", [KOREA, SINGAPORE, NEW_MARKET]);
});

describe("a price update's rows", () => {
  it("say what a new-dated price moves from, and what a changed one replaces", async () => {
    await publishPrice(brand, KOREA, 1380, "2099-02-20");
    await publishPrice(brand, KOREA, 1400, "2099-02-27");
    await publishPrice(brand, SINGAPORE, 1500, "2099-03-06");

    const { batch } = await stageRows({
      siteId: brand.siteId,
      priceDate: "2099-03-06",
      rows: [
        { location: KOREA, price: 1414 },
        { location: SINGAPORE, price: 1515 },
        { location: NEW_MARKET, price: 900 },
      ],
      source: "editorial",
    });

    const detail = await batchDetail([], batch.id);
    const row = (name: string) => detail!.rows.find((r) => r.location === name)!;

    // New on its date: no price that day, last week's is where it moves from.
    expect(row(KOREA)).toMatchObject({ status: "new", old_price: null, previous_price: 1400 });
    // A price already on that date: it changes that one, nothing further back.
    expect(row(SINGAPORE)).toMatchObject({ status: "changed", old_price: 1500, previous_price: null });
    // A market never priced before has nothing to move from.
    expect(row(NEW_MARKET)).toMatchObject({ status: "new", old_price: null, previous_price: null });
  });
});
