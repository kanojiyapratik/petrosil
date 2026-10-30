/**
 * The AI price update, from the app's side: market reports in, a draft price
 * update out, for one brand.
 *
 * The work is the engine's (engine/app/console/flows.py) — reading, the
 * three model passes, currency, the rulebook, rounding, the checks. What
 * lives here is what only the app knows: which brand the person may touch,
 * whether their role allows it, and who they are. Every call checks both
 * before it reaches the engine, so no screen can forget.
 */

import { and, eq, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, priceBatches, sites } from "@/db/schema";
import { AccessError, requireSiteAccess, type Guarded } from "@/lib/auth/guard";
import { engine, engineFile } from "@/lib/engine/client";
import { can, requirePermission } from "@/domain/staff/permissions";

export const AI_PERMISSION = "price-ai-update";

/** Reading five long reports runs a model call per section and per page of pictures. */
const READ_TIMEOUT = 15 * 60_000;
/** Three model passes over every market. */
const DRAFT_TIMEOUT = 10 * 60_000;

type Who = Pick<Guarded, "identity" | "siteIds" | "isSuperadmin">;

/* ------------------------------------------------------------------ shapes */

export type ReadRow = {
  id: number;
  set_id: number;
  file_id: number | null;
  filename: string;
  name: string;
  price: number;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  unit: string | null;
  basis: string | null;
  price_date: string | null;
  note: string | null;
  kept: boolean;
};

export type Reading = {
  id: number;
  created_by: string;
  created_at: string | null;
  used_at: string | null;
  files: { id: number | null; filename: string; rows: ReadRow[] }[];
};

export type Overview = {
  site: { slug: string; name: string; instructions: string | null };
  limits: { documents: number; bytes: number };
  waiting: Reading | null;
  spent: { id: number; used_at: string | null; draft_id: number | null } | null;
};

export type DraftRow = {
  location: string;
  is_benchmark: boolean;
  status: string;
  reported_as: string | null;
  current_price: number | null;
  suggested_min: number | null;
  suggested_max: number | null;
  suggested_price: number | null;
  change_pct: number | null;
  confidence: string | null;
  basis: string | null;
  source: string | null;
  rationale: string | null;
  flag: string | null;
  derived_from: string | null;
  ticked: boolean | null;
  saved_price: number | null;
  detail: (Record<string, unknown> & { money?: string; workings?: string; went_missing?: boolean }) | null;
};

export type Finding = {
  location: string;
  check: string;
  severity: "blocker" | "warning" | string;
  detail: string;
  expected: number | null;
  actual: number | null;
};

export type Draft = {
  draft: {
    id: number;
    reading_set_id: number | null;
    created_by: string;
    created_at: string | null;
    price_date: string | null;
    provider: string | null;
    model: string | null;
    analysis_status: string | null;
    batch_id: number | null;
    saved_by: string | null;
    saved_at: string | null;
    instructions: string | null;
    rows: DraftRow[];
  };
  findings: Finding[];
  blockers: number;
};

export type DraftListItem = {
  id: number;
  created_by: string;
  created_at: string | null;
  price_date: string | null;
  model: string | null;
  analysis_status: string | null;
  batch_id: number | null;
  saved_by: string | null;
  locations: number;
  priced: number;
  kept: number;
};

/* ------------------------------------------------------------------- access */

/** The brand by slug, if this person may use its AI tools. */
async function brandFor(guard: Who, slug: string, database: Database) {
  const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!brand) {
    throw new AccessError("You do not have access to that brand.", 403);
  }

  requireSiteAccess(guard as Guarded, brand.id);
  await requirePermission(guard, brand.id, AI_PERMISSION, database);

  return brand;
}

const actor = (guard: Who) => guard.identity.user.email;

/* --------------------------------------------------------------- the steps */

export async function aiOverview(guard: Who, slug: string, database: Database = db()): Promise<Overview> {
  await brandFor(guard, slug, database);

  return engine<Overview>(slug, "editorial", { actor: actor(guard) });
}

export async function saveAiInstructions(guard: Who, slug: string, text: string, database: Database = db()) {
  await brandFor(guard, slug, database);

  return engine<{ instructions: string | null }>(slug, "instructions", {
    method: "PUT",
    json: { instructions: text },
    actor: actor(guard),
  });
}

/** Step one. `instructions` are for this run only; null sends none. */
export async function readReports(
  guard: Who,
  slug: string,
  input: { files: File[]; instructions: string | null },
  database: Database = db(),
): Promise<{ reading: Reading; failures: string[] }> {
  await brandFor(guard, slug, database);

  const form = new FormData();

  for (const file of input.files) {
    form.append("documents", file, file.name);
  }

  if (input.instructions?.trim()) {
    form.append("instructions", input.instructions.trim());
  }

  return engine(slug, "readings", { method: "POST", form, actor: actor(guard), timeout: READ_TIMEOUT });
}

export async function aiReading(guard: Who, slug: string, id: number, database: Database = db()): Promise<Reading> {
  await brandFor(guard, slug, database);

  return engine<Reading>(slug, `readings/${id}`, { actor: actor(guard) });
}

export type RowFields = {
  name: string;
  price: string;
  price_min?: string;
  price_max?: string;
  currency?: string;
  unit?: string;
  basis?: string;
  price_date?: string;
  note?: string;
  kept: boolean;
};

export async function correctReadRow(
  guard: Who,
  slug: string,
  setId: number,
  rowId: number,
  fields: RowFields,
  database: Database = db(),
): Promise<Reading> {
  await brandFor(guard, slug, database);

  return engine<Reading>(slug, `readings/${setId}/rows/${rowId}`, { method: "PATCH", json: fields, actor: actor(guard) });
}

export async function addReadRow(
  guard: Who,
  slug: string,
  setId: number,
  fields: RowFields & { file_id: number | null; filename: string },
  database: Database = db(),
): Promise<Reading> {
  await brandFor(guard, slug, database);

  return engine<Reading>(slug, `readings/${setId}/rows`, { method: "POST", json: fields, actor: actor(guard) });
}

/** Step two. Answers with the kept draft's id; the draft itself is read back by `aiDraft`. */
export async function draftPrices(
  guard: Who,
  slug: string,
  input: { setId: number; pricedate: string; again?: boolean; usedAt?: string },
  database: Database = db(),
): Promise<{ draft_id: number | null }> {
  await brandFor(guard, slug, database);

  return engine(slug, "drafts", {
    method: "POST",
    json: { set_id: input.setId, pricedate: input.pricedate, again: Boolean(input.again), used_at: input.usedAt ?? "" },
    actor: actor(guard),
    timeout: DRAFT_TIMEOUT,
  });
}

export async function aiDrafts(guard: Who, slug: string, database: Database = db()): Promise<DraftListItem[]> {
  await brandFor(guard, slug, database);

  return (await engine<{ drafts: DraftListItem[] }>(slug, "drafts?limit=20", { actor: actor(guard) })).drafts;
}

export async function aiDraft(guard: Who, slug: string, id: number, database: Database = db()): Promise<Draft> {
  await brandFor(guard, slug, database);

  return engine<Draft>(slug, `drafts/${id}`, { actor: actor(guard) });
}

/**
 * Step three: the kept rows become a draft price update — nothing is
 * published. Staging a price update is its own permission, so it is checked
 * too. The engine stages through the compat API, which has no person to
 * name, so the update is marked as this person's here.
 */
export async function saveAiDraft(
  guard: Who,
  slug: string,
  id: number,
  input: { pricedate: string; rows: { location: string; price: number; calculation?: string }[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ batch_id: number; saved: number }> {
  const brand = await brandFor(guard, slug, database);

  await requirePermission(guard, brand.id, "price-batch-create", database);

  const result = await engine<{ batch_id: number; saved: number }>(slug, `drafts/${id}/save`, {
    method: "POST",
    json: input,
    actor: actor(guard),
  });

  await database
    .update(priceBatches)
    .set({ createdBy: guard.identity.user.id })
    .where(and(eq(priceBatches.id, result.batch_id), eq(priceBatches.siteId, brand.id), isNull(priceBatches.createdBy)));

  await database.insert(auditLog).values({
    siteId: brand.id,
    userId: guard.identity.user.id,
    action: "price.ai_save",
    entity: "price_batch",
    entityId: result.batch_id,
    detail: { draft: id, prices: result.saved },
    ip: context.ip ?? null,
  });

  return result;
}

export async function workingsSheet(guard: Who, slug: string, id: number, database: Database = db()) {
  await brandFor(guard, slug, database);

  return engineFile(slug, `drafts/${id}/workings.csv`, actor(guard));
}

/**
 * After a commit made in the admin: the engine writes the note that goes
 * above the brand's price table, as the console always did after its own
 * commits. Best-effort — the prices are already live, so a failure here is
 * logged and nothing more. Needs only access to the brand: whoever may
 * commit may have the note written.
 */
export async function askForNote(guard: Who, slug: string, batchId: number, database: Database = db()): Promise<void> {
  try {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, slug)).limit(1);

    if (!brand) {
      return;
    }

    requireSiteAccess(guard as Guarded, brand.id);
    await engine(slug, `batches/${batchId}/note`, { method: "POST", actor: actor(guard), timeout: 5 * 60_000 });
  } catch (error) {
    console.error("the price note was not written", { slug, batchId, error });
  }
}

/* ------------------------------------------------------------ AI settings */

export type AiSettings = {
  providers: { id: number; name: string; provider: string; model: string; is_default: boolean; models: string[] }[];
  /** This brand's own provider; null runs on the default one. */
  provider_id: number | null;
  /** Its own model on that provider; null runs the provider's model. */
  model: string | null;
  instructions: string | null;
  /** Whether this person may change the model. */
  canChange: boolean;
};

/** Which AI this brand's work runs on, and what it is told. Never a key. */
export async function aiSettings(guard: Who, slug: string, database: Database = db()): Promise<AiSettings> {
  const brand = await brandFor(guard, slug, database);
  const view = await engine<Omit<AiSettings, "canChange">>(slug, "ai-settings", { actor: actor(guard) });

  return { ...view, canChange: await can(guard, brand.id, "setting-edit", database) };
}

/**
 * Point this brand at a provider and model; a blank provider means the
 * default. Changing settings is its own permission: the model decides both
 * what a draft costs and how well a report is read.
 */
export async function chooseModel(
  guard: Who,
  slug: string,
  input: { providerId: string; model: string },
  database: Database = db(),
): Promise<string> {
  const brand = await brandFor(guard, slug, database);

  await requirePermission(guard, brand.id, "setting-edit", database);

  return (
    await engine<{ message: string }>(slug, "ai-settings", {
      method: "PUT",
      json: { provider_id: input.providerId, model: input.model },
      actor: actor(guard),
    })
  ).message;
}
