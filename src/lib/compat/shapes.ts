/**
 * The JSON the price module expects, byte for byte.
 *
 * These shapes are not ours to improve. They were measured against the live
 * Laravel sites on 2026-10-16 (baseoil and bitumart, through the module's own
 * SiteClient) and the module, its crawler and its tests read exactly these
 * keys. snake_case, `pricedate` as one word, `latest_price` on locations, the
 * summary counters in this order. Anything we want to add goes BESIDE them —
 * the module ignores unknown keys — but nothing here may be renamed or
 * dropped without changing the module in the same breath.
 */

import type { Batch, BatchItem } from "@/domain/price/batches";
import { ITEM_STATUSES } from "@/db/schema";

export type ItemJson = {
  id: number;
  raw_location: string;
  location_id: number | null;
  location: string | null;
  pricedate: string;
  currency: string | null;
  old_price: number | null;
  new_price: number;
  delta: number | null;
  delta_pct: number | null;
  status: string;
  is_included: boolean;
  error_message: string | null;
};

export type BatchJson = {
  id: number;
  status: string;
  source: string;
  created_at: string | null;
};

export type EnvelopeJson = {
  batch: BatchJson;
  summary: Record<string, number>;
  needs_attention: number;
  committable: boolean;
};

export function batchJson(batch: Batch): BatchJson {
  return {
    id: batch.id,
    status: batch.status,
    source: batch.source,
    created_at: batch.createdAt ? batch.createdAt.toISOString() : null,
  };
}

export function itemJson(item: BatchItem, locationTitle: string | null): ItemJson {
  const oldPrice = item.oldPrice === null ? null : Number(item.oldPrice);
  const newPrice = Number(item.newPrice);

  let delta: number | null = null;
  let deltaPct: number | null = null;

  if (oldPrice !== null) {
    delta = round(newPrice - oldPrice, 6);

    if (oldPrice !== 0) {
      deltaPct = round((delta / oldPrice) * 100, 4);
    }
  }

  return {
    id: item.id,
    raw_location: item.rawLocation,
    location_id: item.locationId,
    location: locationTitle,
    pricedate: item.priceDate,
    currency: item.currency,
    old_price: oldPrice,
    new_price: newPrice,
    delta,
    delta_pct: deltaPct,
    status: item.status,
    is_included: item.isIncluded,
    error_message: item.errorMessage,
  };
}

/**
 * Batch, per-status counts, how many included rows need attention, and whether
 * it can be committed right now. One function so the staging endpoints and
 * GET /{id} can never disagree — the same reason the Laravel version kept it
 * in one private method.
 */
export function envelopeJson(batch: Batch, items: BatchItem[]): EnvelopeJson {
  const summary: Record<string, number> = {};

  for (const status of ITEM_STATUSES) {
    summary[status] = items.filter((item) => item.status === status).length;
  }

  const needsAttention = items.filter(
    (item) =>
      item.isIncluded &&
      (item.status === "ambiguous" || item.status === "unmatched" || item.status === "invalid"),
  ).length;

  return {
    batch: batchJson(batch),
    summary,
    needs_attention: needsAttention,
    committable: needsAttention === 0,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;

  return Math.round(value * factor) / factor;
}
