/**
 * The masters: currencies, uploaded files, and the paywalled fields of the
 * directory and offer forms.
 *
 * Currencies are estate-wide here and were per-site before — nine copies of
 * "USD" with nothing to keep them agreeing. The count of locations priced in
 * each is the useful column: it says which of them are actually in use, and
 * therefore which can safely be retired.
 */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  currencies,
  formFields,
  locations,
  mediaFiles,
  sites,
  users,
  type FormKind,
} from "@/db/schema";
import { paging, siteScope, type Paged } from "./scope";

export type CurrencyRow = {
  id: number;
  code: string;
  title: string;
  symbol: string;
  enabled: boolean;
  /** Live locations priced in it, across the estate. */
  locations: number;
};

export async function listCurrencies(database: Database = db()): Promise<CurrencyRow[]> {
  const rows = await database
    .select({
      currency: currencies,
      used: sql<number>`(
        select count(*) from ${locations}
        where ${locations.currency} = ${currencies.code}
          and ${locations.deletedAt} is null
      )`,
    })
    .from(currencies)
    .orderBy(asc(currencies.code));

  return rows.map(({ currency, used }) => ({
    id: currency.id,
    code: currency.code,
    title: currency.title,
    symbol: currency.symbol,
    enabled: currency.enabled,
    locations: Number(used),
  }));
}

export type MediaRow = {
  id: number;
  site: string | null;
  path: string;
  name: string;
  kind: string;
  bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

export async function listMedia(
  siteIds: number[],
  query: { site?: string; kind?: string; page?: number; perPage?: number } = {},
  database: Database = db(),
): Promise<Paged<MediaRow>> {
  const only = await siteScope(siteIds, query.site, database);
  const { page, perPage, offset } = paging(query, 50);

  // A file with no brand belongs to the estate, so staff may see it; one
  // belonging to a brand they cannot see is not theirs.
  const where = and(
    only ? or(isNull(mediaFiles.siteId), inArray(mediaFiles.siteId, only)) : undefined,
    query.kind ? eq(mediaFiles.kind, query.kind) : undefined,
  );

  const [totals] = await database
    .select({ n: sql<number>`count(*)` })
    .from(mediaFiles)
    .where(where);

  const rows = await database
    .select({ file: mediaFiles, slug: sites.slug, who: users.name })
    .from(mediaFiles)
    .leftJoin(sites, eq(sites.id, mediaFiles.siteId))
    .leftJoin(users, eq(users.id, mediaFiles.uploadedBy))
    .where(where)
    .orderBy(sql`${mediaFiles.createdAt} desc`)
    .limit(perPage)
    .offset(offset);

  return {
    rows: rows.map(({ file, slug, who }) => ({
      id: file.id,
      site: slug,
      path: file.path,
      name: file.name,
      kind: file.kind,
      bytes: file.bytes,
      uploaded_by: who,
      created_at: file.createdAt.toISOString(),
    })),
    total: Number(totals?.n ?? 0),
    page,
    per_page: perPage,
  };
}

export type FormFieldRow = {
  id: number;
  site: string;
  site_name: string;
  form: FormKind;
  key: string;
  label: string;
  show_free: boolean;
  show_premium: boolean;
  enabled: boolean;
  sort_order: number;
};

/**
 * Which fields of a directory entry or an offer each tier sees.
 *
 * This is the paywall stated once. The old schema spread it over 44
 * settings rows per site named `city_free` and `offer_phone_premium`, and
 * whether a given one was read by anything was anybody's guess.
 */
export async function listFormFields(
  siteIds: number[],
  form: FormKind,
  query: { site?: string } = {},
  database: Database = db(),
): Promise<FormFieldRow[]> {
  const only = await siteScope(siteIds, query.site, database);

  const rows = await database
    .select({ field: formFields, slug: sites.slug, name: sites.name })
    .from(formFields)
    .innerJoin(sites, eq(sites.id, formFields.siteId))
    .where(and(eq(formFields.form, form), only ? inArray(formFields.siteId, only) : undefined))
    .orderBy(asc(sites.slug), asc(formFields.sortOrder), asc(formFields.key));

  return rows.map(({ field, slug, name }) => ({
    id: field.id,
    site: slug,
    site_name: name,
    form: field.form,
    key: field.key,
    label: field.label,
    show_free: field.showFree,
    show_premium: field.showPremium,
    enabled: field.enabled,
    sort_order: field.sortOrder,
  }));
}

/** The locations that name a currency nothing in the master list covers. */
export async function unknownCurrencies(database: Database = db()): Promise<string[]> {
  const rows = await database
    .selectDistinct({ code: locations.currency })
    .from(locations)
    .where(
      and(
        isNull(locations.deletedAt),
        sql`${locations.currency} is not null`,
        sql`${locations.currency} not in (select ${currencies.code} from ${currencies})`,
      ),
    )
    .orderBy(asc(locations.currency));

  return rows.map((row) => row.code!).filter(Boolean);
}
