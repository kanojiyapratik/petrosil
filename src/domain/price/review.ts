/**
 * "Run analysis": an AI read of a staged batch before anyone commits it —
 * baseoil's old button, now on every brand.
 *
 * The engine does the counting (how many rose and fell, the median move, the
 * rows that look like a slipped digit) and has the brand's own model put it in
 * a short paragraph for the person about to press Commit. The model never
 * counts and never changes a row: this is advice beside the table, and the
 * statuses on the table stay this app's own diff.
 *
 * What is sent is what would publish as it stands now, after any fixes: the
 * included rows that have a market, by the market's own title, and the price
 * each moves from — the live price on its date or, failing that, the market's
 * last published one, which is the move a reader will see.
 *
 * A failure is kept like a result. If the engine is down or the model will
 * not answer, the batch records that the review failed and why, and the
 * button runs it again. The old site did the same rather than an error page.
 *
 * Who may: anyone who may see price updates (`price-batch-view`), as on the
 * old site, where that was a deliberate choice: it reads, it changes nothing.
 */

import { and, eq, gt, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, priceBatchItems, priceBatches, users } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { batchDetail } from "@/domain/dashboard/batches";
import { EngineError, engine } from "@/lib/engine/client";

import { batchOnSite } from "./batches";
import { brandForBatch } from "./entry";

/** One model call over a computed summary: a minute is plenty, two is generous. */
const REVIEW_TIMEOUT = 120_000;

/** Rows whose market or value is still in question say nothing about the move. */
const NOT_REVIEWED = new Set(["invalid", "unmatched", "ambiguous"]);

export type SuspectedError = { location: string; old_price: number | null; new_price: number | null; reason: string };

export type Review = {
  status: string;
  text: string | null;
  model: string | null;
  error: string | null;
  at: string;
  by: string | null;
  suspected: SuspectedError[];
  /** Rows were changed after the review ran: it describes an older batch. */
  stale: boolean;
};

type EngineReview = {
  summary: { suspected_errors?: (SuspectedError & { status?: string })[] } & Record<string, unknown>;
  analysis: { status: string; output_markdown: string | null; model: string | null; error: string | null };
};

export async function reviewBatch(
  guard: Guarded,
  input: { site: string; batchId: number },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ status: string; error: string | null }> {
  const brand = await brandForBatch(guard, input.site, "price-batch-view", database);
  const batch = await batchOnSite(brand.id, input.batchId, database);

  if (!batch) {
    throw new AccountError("No such price update on this brand.", 404, "batch");
  }

  if (batch.status !== "draft") {
    throw new AccountError("Only a draft can be reviewed: this one is no longer waiting to be committed.", 409, "batch");
  }

  const detail = await batchDetail([brand.id], batch.id, database);
  const rows = (detail?.rows ?? []).filter((row) => row.is_included && row.location && !NOT_REVIEWED.has(row.status));

  let outcome: { status: string; text: string | null; summary: unknown; model: string | null; error: string | null };

  if (rows.length === 0) {
    outcome = {
      status: "skipped",
      text: null,
      summary: null,
      model: null,
      error: "There were no rows to review: every row is left out, or still needs its market or its value fixed.",
    };
  } else {
    // A sheet can carry several dates. The review is of the date most rows
    // are for; with more than one, each market is named with its date so
    // the same market on two dates stays two rows.
    const byDate = new Map<string, number>();

    for (const row of rows) {
      byDate.set(row.price_date, (byDate.get(row.price_date) ?? 0) + 1);
    }

    const priceDate = [...byDate.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]![0];
    const name = (row: (typeof rows)[number]) => (byDate.size > 1 ? `${row.location} (${row.price_date})` : row.location!);

    try {
      const answer = await engine<EngineReview>(brand.slug, `batches/${batch.id}/review`, {
        method: "POST",
        actor: guard.identity.user.email,
        timeout: REVIEW_TIMEOUT,
        json: {
          price_date: priceDate,
          rows: rows.map((row) => ({ location: name(row), price: row.new_price })),
          current_prices: rows
            .filter((row) => (row.old_price ?? row.previous_price) !== null)
            .map((row) => ({ location: name(row), price: (row.old_price ?? row.previous_price)! })),
        },
      });

      outcome = {
        status: answer.analysis.status,
        text: answer.analysis.output_markdown?.trim() || null,
        summary: answer.summary,
        model: answer.analysis.model,
        error: answer.analysis.error,
      };
    } catch (error) {
      if (!(error instanceof EngineError)) {
        throw error;
      }

      outcome = { status: "failed", text: null, summary: null, model: null, error: error.message };
    }
  }

  await database
    .update(priceBatches)
    .set({
      analysisStatus: outcome.status.slice(0, 24),
      analysisText: outcome.text,
      analysisSummary: outcome.summary,
      analysisModel: outcome.model?.slice(0, 120) ?? null,
      analysisError: outcome.error,
      analysisAt: new Date(),
      analysisBy: guard.identity.user.id,
    })
    .where(eq(priceBatches.id, batch.id));

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "price_batch.review",
    entity: "price_batch",
    entityId: batch.id,
    detail: { status: outcome.status, model: outcome.model, rows: rows.length },
    ip: context.ip ?? null,
  });

  return { status: outcome.status, error: outcome.error };
}

/** The batch's last review, for its page. Null when none has run. */
export async function reviewOf(batchId: number, database: Database = db()): Promise<Review | null> {
  const [row] = await database
    .select({ batch: priceBatches, by: users.name })
    .from(priceBatches)
    .leftJoin(users, eq(users.id, priceBatches.analysisBy))
    .where(eq(priceBatches.id, batchId))
    .limit(1);

  if (!row?.batch.analysisAt || !row.batch.analysisStatus) {
    return null;
  }

  const [edited] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(priceBatchItems)
    .where(and(eq(priceBatchItems.batchId, batchId), gt(priceBatchItems.updatedAt, row.batch.analysisAt)));

  const summary = row.batch.analysisSummary as EngineReview["summary"] | null;

  return {
    status: row.batch.analysisStatus,
    text: row.batch.analysisText,
    model: row.batch.analysisModel,
    error: row.batch.analysisError,
    at: row.batch.analysisAt.toISOString(),
    by: row.by,
    suspected: (summary?.suspected_errors ?? []).map(({ location, old_price, new_price, reason }) => ({ location, old_price, new_price, reason })),
    stale: (edited?.n ?? 0) > 0,
  };
}
