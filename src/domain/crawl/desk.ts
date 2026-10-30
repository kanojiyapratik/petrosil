/**
 * The crawler, from the admin: run a pass now, see what it found, and turn
 * the findings worth keeping into a draft price update.
 *
 * The findings and the staging are this app's own data (domain/crawl/
 * activity.ts). Two things need the AI engine: running a pass — the engine
 * owns the crawler and its model — and suggesting which market a finding the
 * brand has no market for probably is. A suggestion is only ever that; the
 * person picks, and the pick is recorded.
 */

import { and, eq, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, priceBatches, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { engine } from "@/lib/engine/client";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { stageRows } from "@/domain/price/batches";
import { NothingToStage, clearActivity, recentActivity, stageActivities, type ActivityJson } from "./activity";

/** A pass over every watched page runs a model call per changed page. */
const CRAWL_TIMEOUT = 10 * 60_000;

async function brandFor(guard: Guarded, slug: string, permission: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand || (!guard.isSuperadmin && !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You do not have access to that brand.", 403, "site");
  }

  await requirePermission(guard, brand.id, permission, database);

  return brand;
}

export async function findings(guard: Guarded, slug: string, database: Database = db()): Promise<ActivityJson[]> {
  const brand = await brandFor(guard, slug, "price-batch-view", database);

  return recentActivity(brand.id, 100, database);
}

/** One pass now, rather than at the next quarter hour. Answers with what happened. */
export async function crawlNow(guard: Guarded, slug: string, database: Database = db()): Promise<string> {
  await brandFor(guard, slug, "price-batch-create", database);

  const result = await engine<{ message: string }>(slug, "crawl", {
    method: "POST",
    actor: guard.identity.user.email,
    timeout: CRAWL_TIMEOUT,
  });

  return result.message;
}

export type Proposal = { match: string | null; caution: string };

/** Which of the brand's markets each unplaced finding probably is. Asked only when someone asks. */
export async function suggestMarkets(
  guard: Guarded,
  slug: string,
  database: Database = db(),
): Promise<Record<string, Proposal>> {
  const brand = await brandFor(guard, slug, "price-batch-create", database);
  const unplaced = (await recentActivity(brand.id, 100, database)).filter((row) => row.location_id === null);

  if (unplaced.length === 0) {
    return {};
  }

  const answer = await engine<{ proposals: Record<string, Proposal> }>(slug, "crawl/matches", {
    method: "POST",
    json: { findings: unplaced.map((row) => ({ id: row.id, location: row.location, price: row.price })) },
    actor: guard.identity.user.email,
    timeout: 3 * 60_000,
  });

  return answer.proposals;
}

/**
 * The findings someone ticked, as draft price updates: those the brand
 * already places go in as they are; those the person matched to a market by
 * hand go in under that market. Nothing is published.
 */
export async function stageFindings(
  guard: Guarded,
  slug: string,
  input: { ids: number[]; matched: { id: number; location: string }[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<string> {
  const brand = await brandFor(guard, slug, "price-batch-create", database);
  const userId = guard.identity.user.id;
  const said: string[] = [];

  if (input.ids.length === 0 && input.matched.length === 0) {
    throw new AccountError("Tick at least one finding.", 422);
  }

  if (input.ids.length) {
    try {
      const { batch, rows, skipped } = await stageActivities(brand.id, input.ids, database);

      await database
        .update(priceBatches)
        .set({ createdBy: userId })
        .where(and(eq(priceBatches.id, batch.id), isNull(priceBatches.createdBy)));
      await database.insert(auditLog).values({
        siteId: brand.id,
        userId,
        action: "crawl.stage",
        entity: "price_batch",
        entityId: batch.id,
        detail: { findings: input.ids.length, rows, skipped },
        ip: context.ip ?? null,
      });
      said.push(`Staged price update #${batch.id} with ${rows} price${rows === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}.`);
    } catch (error) {
      if (error instanceof NothingToStage) {
        throw new AccountError(error.message, 422);
      }

      throw error;
    }
  }

  if (input.matched.length) {
    const byId = new Map((await recentActivity(brand.id, 200, database)).map((row) => [row.id, row]));
    const picked = input.matched
      .map((pick) => ({ pick, finding: byId.get(pick.id) }))
      .filter((entry): entry is { pick: { id: number; location: string }; finding: ActivityJson } => Boolean(entry.finding && entry.pick.location));

    if (picked.length) {
      const { batch } = await stageRows(
        {
          siteId: brand.id,
          rows: picked.map(({ pick, finding }) => ({ location: pick.location, price: finding.price, date: finding.price_date })),
          source: "crawl",
          userId,
        },
        database,
      );

      // Each match by hand is a judgement worth being able to read back.
      await database.insert(auditLog).values(
        picked.map(({ pick, finding }) => ({
          siteId: brand.id,
          userId,
          action: "crawl.match",
          entity: "price_batch",
          entityId: batch.id,
          detail: { found_as: finding.location, matched_to: pick.location, price: finding.price },
          ip: context.ip ?? null,
        })),
      );
      said.push(`Staged price update #${batch.id} with ${picked.length} price${picked.length === 1 ? "" : "s"} matched by hand.`);
    }
  }

  return `${said.join(" ")} Nothing is on the website yet.`;
}

/** Empty the findings list. Prices already staged or published are untouched. */
export async function clearFindings(
  guard: Guarded,
  slug: string,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<string> {
  const brand = await brandFor(guard, slug, "price-batch-create", database);
  const { removed } = await clearActivity(brand.id, database);

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "crawl.clear",
    entity: "site",
    entityId: brand.id,
    detail: { removed },
    ip: context.ip ?? null,
  });

  return `Cleared ${removed} finding${removed === 1 ? "" : "s"}.`;
}
