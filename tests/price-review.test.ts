/**
 * "Run analysis": the AI's read of a draft batch before commit.
 *
 * The engine is stood in for (vi.mock): pinned here is what the app sends —
 * only rows that would publish, by market title, each with the price it moves
 * from — and that every outcome, a failure included, is stored and shown
 * rather than thrown, and goes stale when a row is changed afterwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, priceBatchItems, priceBatches, users } from "@/db/schema";
import { stageRows } from "@/domain/price/batches";
import { editRow } from "@/domain/price/upload";
import { reviewBatch, reviewOf } from "@/domain/price/review";
import { makeBrand, publishPrice, resetDatabase, type Brand } from "./helpers";

const calls: { slug: string | null; path: string; json: unknown }[] = [];
let answer: () => unknown = () => ({});

vi.mock("@/lib/engine/client", async (original) => {
  const real = await original<typeof import("@/lib/engine/client")>();

  return {
    ...real,
    engine: vi.fn(async (slug: string | null, path: string, call: { json?: unknown }) => {
      calls.push({ slug, path, json: call.json });

      return answer();
    }),
  };
});

const KOREA = "Korea SN 150";
const SG = "Singapore SN 150";
const UAE = "UAE SN 500";

let brand: Brand;
let staff: number;

const guard = () => ({ identity: { user: { id: staff, email: "editor@petrosil.example" }, memberships: [] }, siteIds: [], isSuperadmin: true }) as never;

const done = (text: string, suspected: unknown[] = []) => () => ({
  summary: { total_rows: 2, suspected_errors: suspected },
  analysis: { status: "complete", output_markdown: text, model: "gpt-4.1", error: null },
});

async function stage(rows: { location: string; price: number }[], priceDate = "2099-03-06") {
  return (await stageRows({ siteId: brand.siteId, priceDate, rows, source: "upload", userId: staff })).batch;
}

beforeEach(async () => {
  calls.length = 0;
  answer = done("Looks fine.");
  await resetDatabase();
  brand = await makeBrand("baseoil", [KOREA, SG, UAE]);

  const [me] = await db().insert(users).values({ email: "editor@petrosil.example", name: "Editor" }).returning();

  staff = me!.id;
});

describe("running the review", () => {
  it("sends what would publish, with what each row moves from, and keeps the answer", async () => {
    await publishPrice(brand, KOREA, 1400, "2099-02-27");
    await publishPrice(brand, SG, 1500, "2099-03-06");

    const batch = await stage([
      { location: KOREA, price: 1414 },
      { location: SG, price: 15150 },
      { location: "Atlantis SN 1", price: 5 },
    ]);

    answer = done("Singapore looks like a slipped digit.", [{ location: SG, old_price: 1500, new_price: 15150, status: "changed", reason: "moved tenfold" }]);

    expect(await reviewBatch(guard(), { site: "baseoil", batchId: batch.id })).toEqual({ status: "complete", error: null });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ slug: "baseoil", path: `batches/${batch.id}/review` });
    // The unmatched row is not sent; Korea moves from last week's price, Singapore from that day's.
    expect(calls[0]!.json).toEqual({
      price_date: "2099-03-06",
      rows: [
        { location: KOREA, price: 1414 },
        { location: SG, price: 15150 },
      ],
      current_prices: [
        { location: KOREA, price: 1400 },
        { location: SG, price: 1500 },
      ],
    });

    const shown = await reviewOf(batch.id);
    expect(shown).toMatchObject({ status: "complete", text: "Singapore looks like a slipped digit.", model: "gpt-4.1", by: "Editor", stale: false });
    expect(shown!.suspected).toEqual([{ location: SG, old_price: 1500, new_price: 15150, reason: "moved tenfold" }]);

    const [entry] = await db().select().from(auditLog).where(eq(auditLog.action, "price_batch.review"));
    expect(entry).toMatchObject({ entityId: batch.id, userId: staff, detail: { status: "complete", model: "gpt-4.1", rows: 2 } });
  });

  it("names each market with its date when the batch spans dates", async () => {
    const one = await stage([{ location: KOREA, price: 1 }], "2099-03-06");
    // Move a second row of the same market onto another date.
    const [row] = await db().select().from(priceBatchItems).where(eq(priceBatchItems.batchId, one.id));
    await db().insert(priceBatchItems).values({ ...row!, id: undefined, priceDate: "2099-03-13", newPrice: "2" });

    await reviewBatch(guard(), { site: "baseoil", batchId: one.id });

    const sent = calls[0]!.json as { price_date: string; rows: { location: string }[] };
    expect(sent.rows.map((r) => r.location).sort()).toEqual([`${KOREA} (2099-03-06)`, `${KOREA} (2099-03-13)`]);
  });

  it("keeps a failure as the review, and says when there is nothing to review", async () => {
    const { EngineError } = await import("@/lib/engine/client");
    const batch = await stage([{ location: KOREA, price: 1414 }]);

    answer = () => {
      throw new EngineError("The AI engine could not be reached. Try again in a minute.", 502);
    };

    expect(await reviewBatch(guard(), { site: "baseoil", batchId: batch.id })).toMatchObject({ status: "failed" });
    expect(await reviewOf(batch.id)).toMatchObject({ status: "failed", error: "The AI engine could not be reached. Try again in a minute.", text: null });

    const nothing = await stage([{ location: "Atlantis SN 1", price: 5 }]);
    calls.length = 0;

    expect((await reviewBatch(guard(), { site: "baseoil", batchId: nothing.id })).status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("goes stale when a row is changed after it", async () => {
    const batch = await stage([{ location: KOREA, price: 1414 }]);

    await reviewBatch(guard(), { site: "baseoil", batchId: batch.id });
    expect((await reviewOf(batch.id))!.stale).toBe(false);

    const [row] = await db().select().from(priceBatchItems).where(eq(priceBatchItems.batchId, batch.id));
    await editRow(guard(), { site: "baseoil", itemId: row!.id, patch: { new_price: "1420" } });

    expect((await reviewOf(batch.id))!.stale).toBe(true);
  });

  it("is only for a draft", async () => {
    const batch = await stage([{ location: KOREA, price: 1414 }]);
    await db().update(priceBatches).set({ status: "committed" }).where(eq(priceBatches.id, batch.id));

    await expect(reviewBatch(guard(), { site: "baseoil", batchId: batch.id })).rejects.toThrow(/Only a draft/);
    expect(await reviewOf(batch.id)).toBeNull();
  });
});
