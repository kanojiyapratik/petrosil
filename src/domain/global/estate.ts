/**
 * Global settings: the things every brand has, edited once.
 *
 * The nine brands each hold their own copy of the same pages, the same
 * twelve system emails and the same field-visibility rules. Most copies say
 * the same thing but for the brand's own name, and keeping them in step
 * meant nine edits. Here a copy is read with the brand's name taken out
 * (`{brand}` in its place), so copies that differ only by name group into
 * one version; and one version is applied to every brand ticked, with
 * `{brand}` written as each brand's name.
 *
 * Applying writes each brand's own row. A brand that needs to say something
 * different keeps its row and is simply not ticked, and the brand screens
 * still edit one brand at a time.
 */

import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";

import { db, type Database } from "@/db";
import {
  adPlacements,
  ads,
  articleCategories,
  articles,
  auditLog,
  formFields,
  mailTemplates,
  pages,
  sites,
} from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";
import { deletePlacement, savePlacement } from "@/domain/ads/editor";
import { deleteCategory, saveCategory } from "@/domain/content/categories";
import { deletePage } from "@/domain/content/pages";

type Brand = { id: number; slug: string; name: string };

/** `{brand}` written as the brand's name. */
export function brandText(text: string, name: string): string {
  return text.split("{brand}").join(name);
}

/** The brand's name taken out, so copies that differ only by it compare equal. */
function neutral(text: string, name: string): string {
  return name ? text.split(name).join("{brand}") : text;
}

/** The brands in view: all for a superadmin, the granted ones otherwise. */
async function brandsIn(siteIds: number[], database: Database): Promise<Brand[]> {
  return database
    .select({ id: sites.id, slug: sites.slug, name: sites.name })
    .from(sites)
    .where(siteIds.length > 0 ? inArray(sites.id, siteIds) : undefined)
    .orderBy(asc(sites.slug));
}

/** The ticked brands, every one of them the editor's, or a refusal before anything is written. */
async function ticked(guard: Guarded, slugs: unknown[], database: Database): Promise<Brand[]> {
  const wanted = [...new Set(slugs.map((value) => String(value ?? "").trim()).filter(Boolean))];

  if (wanted.length === 0) {
    throw new AccountError("Tick at least one brand.", 422, "sites");
  }

  const found = await database
    .select({ id: sites.id, slug: sites.slug, name: sites.name })
    .from(sites)
    .where(inArray(sites.slug, wanted))
    .orderBy(asc(sites.slug));

  if (found.length !== wanted.length) {
    throw new AccountError("One of those brands does not exist.", 422, "sites");
  }

  if (!guard.isSuperadmin && found.some((brand) => !guard.siteIds.includes(brand.id))) {
    throw new AccountError("You can only apply this to brands you manage.", 403, "sites");
  }

  return found;
}

export type Version<T> = T & { brands: { slug: string; name: string }[] };

/** Copies grouped by what they say, the biggest group first. */
function group<T>(copies: { brand: Brand; value: T }[]): Version<T>[] {
  const byKey = new Map<string, Version<T>>();

  for (const { brand, value } of copies) {
    const key = JSON.stringify(value);
    const version = byKey.get(key) ?? { ...value, brands: [] };

    version.brands.push({ slug: brand.slug, name: brand.name });
    byKey.set(key, version);
  }

  return [...byKey.values()].sort(
    (a, b) => b.brands.length - a.brands.length || a.brands[0]!.slug.localeCompare(b.brands[0]!.slug),
  );
}

/* ------------------------------------------------------------------ pages */

type PageVersion = { title: string; body: string; visible: boolean };

async function pageCopies(siteIds: number[], database: Database, slug?: string) {
  const brands = await brandsIn(siteIds, database);
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  const rows = brands.length
    ? await database
        .select()
        .from(pages)
        .where(and(inArray(pages.siteId, [...byId.keys()]), slug ? eq(pages.slug, slug) : undefined))
    : [];

  return { brands, rows: rows.map((row) => ({ row, brand: byId.get(row.siteId)! })) };
}

/** Every page address in view, with how many brands have it and in how many versions. */
export async function globalPages(siteIds: number[], database: Database = db()) {
  const { brands, rows } = await pageCopies(siteIds, database);
  const bySlug = new Map<string, typeof rows>();

  for (const copy of rows) {
    bySlug.set(copy.row.slug, [...(bySlug.get(copy.row.slug) ?? []), copy]);
  }

  return [...bySlug.entries()]
    .map(([slug, copies]) => {
      const versions = group<PageVersion>(
        copies.map(({ row, brand }) => ({
          brand,
          value: { title: neutral(row.title, brand.name), body: neutral(row.body, brand.name), visible: row.visible },
        })),
      );

      return { slug, title: versions[0]!.title, brands: copies.length, of: brands.length, versions: versions.length };
    })
    .sort((a, b) => b.brands - a.brands || a.slug.localeCompare(b.slug));
}

/** One page address across the brands in view. */
export async function globalPage(siteIds: number[], slug: string, database: Database = db()) {
  const { brands, rows } = await pageCopies(siteIds, database, slug);

  if (rows.length === 0) {
    return null;
  }

  const holding = new Set(rows.map(({ brand }) => brand.id));

  return {
    slug,
    versions: group<PageVersion>(
      rows.map(({ row, brand }) => ({
        brand,
        value: { title: neutral(row.title, brand.name), body: neutral(row.body, brand.name), visible: row.visible },
      })),
    ),
    missing: brands.filter((brand) => !holding.has(brand.id)).map(({ slug: s, name }) => ({ slug: s, name })),
  };
}

const PAGE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Write one version of a page to every brand ticked; created where a brand lacks it. */
export async function applyPage(
  guard: Guarded,
  input: {
    slug: string;
    /** A new address for the page on the ticked brands. Blank or absent: it stays where it is. */
    new_slug?: string;
    title: unknown;
    body: unknown;
    visible: boolean;
    sites: unknown[];
  },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ created: number; updated: number }> {
  const slug = String(input.slug ?? "").trim();
  const target = String(input.new_slug ?? "").trim().toLowerCase() || slug;
  const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, 255);
  const body = String(input.body ?? "");

  if (!PAGE_SLUG.test(slug) || !PAGE_SLUG.test(target)) {
    throw new AccountError("An address is lower-case words joined by hyphens, like terms-of-use.", 422, "slug");
  }

  if (title === "") {
    throw new AccountError("Give the page a title.", 422, "title");
  }

  const brands = await ticked(guard, input.sites, database);
  const rows = await database
    .select({ id: pages.id, siteId: pages.siteId, slug: pages.slug })
    .from(pages)
    .where(and(inArray(pages.slug, [slug, target]), inArray(pages.siteId, brands.map((brand) => brand.id))));
  const has = new Map(rows.filter((row) => row.slug === slug).map((row) => [row.siteId, row.id]));

  for (const brand of brands) {
    await requirePermission(guard, brand.id, has.has(brand.id) ? "page-edit" : "page-create", database);

    // Moving to an address a brand already uses would leave two pages on one link.
    if (target !== slug && rows.some((row) => row.siteId === brand.id && row.slug === target)) {
      throw new AccountError(`${brand.name} already has a page at /${target}.`, 409, "slug");
    }
  }

  return database.transaction(async (tx) => {
    let created = 0;

    for (const brand of brands) {
      const values = {
        title: brandText(title, brand.name),
        body: brandText(body, brand.name),
        visible: input.visible,
        slug: target,
        updatedAt: new Date(),
      };
      const id = has.get(brand.id);

      const [row] = id
        ? await tx.update(pages).set(values).where(eq(pages.id, id)).returning({ id: pages.id })
        : await tx.insert(pages).values({ ...values, siteId: brand.id }).returning({ id: pages.id });

      created += id ? 0 : 1;

      await tx.insert(auditLog).values({
        siteId: brand.id,
        userId: guard.identity.user.id,
        action: "page.global",
        entity: "page",
        entityId: row!.id,
        detail: {
          slug: target,
          ...(id && target !== slug ? { moved: { from: slug, to: target } } : {}),
          title: values.title,
          created: !id,
          brands: brands.map((b) => b.slug),
        },
        ip: context.ip ?? null,
      });
    }

    return { created, updated: brands.length - created };
  });
}

/** Delete a page from the ticked brands. Its words are kept in each brand's audit trail. */
export async function removePage(
  guard: Guarded,
  input: { slug: string; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ removed: number }> {
  const brands = await ticked(guard, input.sites, database);
  const rows = await database
    .select({ id: pages.id, siteId: pages.siteId })
    .from(pages)
    .where(and(eq(pages.slug, String(input.slug ?? "")), inArray(pages.siteId, brands.map((brand) => brand.id))));

  for (const row of rows) {
    await requirePermission(guard, row.siteId, "page-delete", database);
  }

  let removed = 0;

  for (const row of rows) {
    removed += (await deletePage(guard, row.id, context, database)) ? 1 : 0;
  }

  return { removed };
}

/* ---------------------------------------------------------- system emails */

type EmailVersion = { subject: string; body: string; enabled: boolean };

async function emailCopies(siteIds: number[], database: Database, key?: string, variant?: string) {
  const brands = await brandsIn(siteIds, database);
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  const rows = brands.length
    ? await database
        .select()
        .from(mailTemplates)
        .where(
          and(
            inArray(mailTemplates.siteId, [...byId.keys()]),
            key ? eq(mailTemplates.key, key) : undefined,
            variant ? eq(mailTemplates.variant, variant) : undefined,
          ),
        )
    : [];

  return { brands, rows: rows.map((row) => ({ row, brand: byId.get(row.siteId)! })) };
}

const emailVersion = (row: typeof mailTemplates.$inferSelect, brand: Brand): EmailVersion => ({
  subject: neutral(row.subject, brand.name),
  body: neutral(row.body, brand.name),
  enabled: row.enabled,
});

/** Every system email in view, with how many brands have it and in how many versions. */
export async function globalEmails(siteIds: number[], database: Database = db()) {
  const { brands, rows } = await emailCopies(siteIds, database);
  const byKey = new Map<string, typeof rows>();

  for (const copy of rows) {
    const id = `${copy.row.key}|${copy.row.variant}`;

    byKey.set(id, [...(byKey.get(id) ?? []), copy]);
  }

  return [...byKey.values()]
    .map((copies) => ({
      key: copies[0]!.row.key,
      variant: copies[0]!.row.variant,
      title: copies[0]!.row.title,
      brands: copies.length,
      of: brands.length,
      versions: group(copies.map(({ row, brand }) => ({ brand, value: emailVersion(row, brand) }))).length,
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.variant.localeCompare(b.variant));
}

/** One system email across the brands in view. */
export async function globalEmail(siteIds: number[], key: string, variant: string, database: Database = db()) {
  const { brands, rows } = await emailCopies(siteIds, database, key, variant);

  if (rows.length === 0) {
    return null;
  }

  const holding = new Set(rows.map(({ brand }) => brand.id));

  return {
    key,
    variant,
    title: rows[0]!.row.title,
    versions: group(rows.map(({ row, brand }) => ({ brand, value: emailVersion(row, brand) }))),
    missing: brands.filter((brand) => !holding.has(brand.id)).map(({ slug, name }) => ({ slug, name })),
  };
}

/**
 * Write one version of a system email to every brand ticked.
 *
 * `{brand}` is written now; the email's own placeholders (`{name}`,
 * `{expiry_date}` …) are left as typed for the sender to fill.
 */
export async function applyEmail(
  guard: Guarded,
  input: { key: string; variant: string; subject: unknown; body: unknown; enabled: boolean; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ created: number; updated: number }> {
  const subject = String(input.subject ?? "").trim().slice(0, 255);
  const body = String(input.body ?? "").trim();

  if (subject === "") {
    throw new AccountError("A mail needs a subject.", 422, "subject");
  }

  if (body === "") {
    throw new AccountError("A mail needs something to say.", 422, "body");
  }

  const [known] = await database
    .select({ title: mailTemplates.title })
    .from(mailTemplates)
    .where(and(eq(mailTemplates.key, input.key), eq(mailTemplates.variant, input.variant)))
    .limit(1);

  if (!known) {
    throw new AccountError("We do not know that email.", 404);
  }

  const brands = await ticked(guard, input.sites, database);
  const existing = await database
    .select({ id: mailTemplates.id, siteId: mailTemplates.siteId })
    .from(mailTemplates)
    .where(
      and(
        eq(mailTemplates.key, input.key),
        eq(mailTemplates.variant, input.variant),
        inArray(mailTemplates.siteId, brands.map((brand) => brand.id)),
      ),
    );
  const has = new Map(existing.map((row) => [row.siteId, row.id]));

  for (const brand of brands) {
    await requirePermission(guard, brand.id, has.has(brand.id) ? "mail-edit" : "mail-create", database);
  }

  return database.transaction(async (tx) => {
    let created = 0;

    for (const brand of brands) {
      const values = {
        subject: brandText(subject, brand.name).slice(0, 255),
        body: brandText(body, brand.name),
        enabled: input.enabled,
        updatedAt: new Date(),
      };
      const id = has.get(brand.id);

      const [row] = id
        ? await tx.update(mailTemplates).set(values).where(eq(mailTemplates.id, id)).returning({ id: mailTemplates.id })
        : await tx
            .insert(mailTemplates)
            .values({ ...values, siteId: brand.id, key: input.key, variant: input.variant, title: known.title })
            .returning({ id: mailTemplates.id });

      created += id ? 0 : 1;

      await tx.insert(auditLog).values({
        siteId: brand.id,
        userId: guard.identity.user.id,
        action: "mail_template.global",
        entity: "mail_template",
        entityId: row!.id,
        detail: { key: input.key, variant: input.variant, created: !id, brands: brands.map((b) => b.slug) },
        ip: context.ip ?? null,
      });
    }

    return { created, updated: brands.length - created };
  });
}

/* ------------------------------------------------------- field visibility */

export type FieldForm = "directory" | "offer";

/** Each field of a form, and how many brands show it to free and paying readers. */
export async function globalFields(siteIds: number[], form: FieldForm, database: Database = db()) {
  const brands = await brandsIn(siteIds, database);
  const rows = brands.length
    ? await database
        .select()
        .from(formFields)
        .where(and(eq(formFields.form, form), inArray(formFields.siteId, brands.map((brand) => brand.id))))
        .orderBy(asc(formFields.sortOrder), asc(formFields.key))
    : [];

  const byKey = new Map<string, typeof rows>();

  for (const row of rows) {
    byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  }

  return [...byKey.entries()].map(([key, copies]) => {
    const rule = (row: (typeof copies)[number]) => `${row.showFree}|${row.showPremium}|${row.enabled}`;

    return {
      key,
      label: copies[0]!.label,
      brands: copies.length,
      of: brands.length,
      free: copies.filter((row) => row.showFree).length,
      premium: copies.filter((row) => row.showPremium).length,
      enabled: copies.filter((row) => row.enabled).length,
      agreed: new Set(copies.map(rule)).size === 1,
    };
  });
}

/** Set one field's rule on every brand ticked. Brands without that field are reported, not given one. */
export async function applyField(
  guard: Guarded,
  input: { form: FieldForm; key: string; show_free: boolean; show_premium: boolean; enabled: boolean; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ updated: number; missing: string[] }> {
  if (input.form !== "directory" && input.form !== "offer") {
    throw new AccountError("Choose the directory or the offer form.", 422, "form");
  }

  const brands = await ticked(guard, input.sites, database);

  for (const brand of brands) {
    await requirePermission(guard, brand.id, "setting-edit", database);
  }

  const rows = await database
    .select({ id: formFields.id, siteId: formFields.siteId })
    .from(formFields)
    .where(
      and(
        eq(formFields.form, input.form),
        eq(formFields.key, input.key),
        inArray(formFields.siteId, brands.map((brand) => brand.id)),
      ),
    );
  const holding = new Set(rows.map((row) => row.siteId));

  if (rows.length > 0) {
    await database
      .update(formFields)
      .set({ showFree: input.show_free, showPremium: input.show_premium, enabled: input.enabled })
      .where(inArray(formFields.id, rows.map((row) => row.id)));

    await database.insert(auditLog).values(
      rows.map((row) => ({
        siteId: row.siteId,
        userId: guard.identity.user.id,
        action: "form-field.global",
        entity: "form_fields",
        entityId: row.id,
        detail: { form: input.form, field: input.key, free: input.show_free, premium: input.show_premium, enabled: input.enabled },
        ip: context.ip ?? null,
      })),
    );
  }

  return { updated: rows.length, missing: brands.filter((brand) => !holding.has(brand.id)).map((brand) => brand.slug) };
}

/* ------------------------------------------------- ad slots and categories */

/**
 * Slots and categories are names, not text: what is worth seeing is which
 * brands have each one. Names are compared trimmed and ignoring case, as the
 * per-brand rules compare them. Changes go through those same per-brand
 * functions, so their checks and audit entries hold here too; everything
 * that could refuse is checked for every ticked brand before the first one
 * is changed.
 */

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Named<T> = { brand: Brand; row: T };

function byName<T>(copies: Named<T>[], nameOf: (row: T) => string, of: number) {
  const groups = new Map<string, Named<T>[]>();

  for (const copy of copies) {
    const key = nameOf(copy.row).trim().toLowerCase();

    groups.set(key, [...(groups.get(key) ?? []), copy]);
  }

  return [...groups.values()]
    .map((group) => ({ name: nameOf(group[0]!.row), copies: group, of }))
    .sort((a, b) => b.copies.length - a.copies.length || a.name.localeCompare(b.name));
}

/** Every ad slot name in view, and the brands that have it. */
export async function globalSlots(siteIds: number[], database: Database = db()) {
  const brands = await brandsIn(siteIds, database);
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  const rows = brands.length
    ? await database.select().from(adPlacements).where(inArray(adPlacements.siteId, [...byId.keys()]))
    : [];
  const placed = rows.length
    ? await database
        .select({ placementId: ads.placementId, n: count() })
        .from(ads)
        .where(and(inArray(ads.placementId, rows.map((row) => row.id)), isNull(ads.deletedAt)))
        .groupBy(ads.placementId)
    : [];
  const adsIn = new Map(placed.map((row) => [row.placementId, Number(row.n)]));

  return byName(
    rows.map((row) => ({ brand: byId.get(row.siteId)!, row })),
    (row) => row.title,
    brands.length,
  ).map((group) => ({
    title: group.name,
    of: group.of,
    brands: group.copies
      .map(({ brand, row }) => ({ slug: brand.slug, name: brand.name, enabled: row.enabled, ads: adsIn.get(row.id) ?? 0 }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  }));
}

/** Add a slot to the ticked brands that lack it; rename it and set whether it is offered where they have it. */
export async function applySlot(
  guard: Guarded,
  input: { title: string; new_title?: string; enabled: boolean; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ created: number; updated: number }> {
  const brands = await ticked(guard, input.sites, database);
  const to = String(input.new_title ?? "").trim() || String(input.title ?? "").trim();

  if (to === "") {
    throw new AccountError("Give the slot a name.", 422, "new_title");
  }

  const rows = await database
    .select()
    .from(adPlacements)
    .where(inArray(adPlacements.siteId, brands.map((brand) => brand.id)));
  const plan = brands.map((brand) => ({
    brand,
    existing: rows.find((row) => row.siteId === brand.id && sameName(row.title, input.title)),
  }));

  for (const { brand, existing } of plan) {
    await requirePermission(guard, brand.id, existing ? "adlocation-edit" : "adlocation-create", database);

    if (rows.some((row) => row.siteId === brand.id && row.id !== existing?.id && sameName(row.title, to))) {
      throw new AccountError(`${brand.name} already has a slot called "${to}".`, 409, "new_title");
    }
  }

  for (const { brand, existing } of plan) {
    await savePlacement(
      guard,
      existing ? { id: existing.id, title: to, enabled: input.enabled } : { site: brand.slug, title: to, enabled: input.enabled },
      context,
      database,
    );
  }

  const created = plan.filter((step) => !step.existing).length;

  return { created, updated: plan.length - created };
}

/** Remove a slot from the ticked brands; a brand with ads in it keeps it and is named back. */
export async function removeSlot(
  guard: Guarded,
  input: { title: string; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ removed: number; kept: string[] }> {
  const brands = await ticked(guard, input.sites, database);
  const rows = await database
    .select()
    .from(adPlacements)
    .where(inArray(adPlacements.siteId, brands.map((brand) => brand.id)));
  const kept: string[] = [];
  let removed = 0;

  for (const brand of brands) {
    const existing = rows.find((row) => row.siteId === brand.id && sameName(row.title, input.title));

    if (!existing) {
      continue;
    }

    try {
      removed += (await deletePlacement(guard, existing.id, context, database)) ? 1 : 0;
    } catch (error) {
      if (error instanceof AccountError && error.status === 409) {
        kept.push(brand.slug);
      } else {
        throw error;
      }
    }
  }

  return { removed, kept };
}

/** Every category name in view, and the brands that have it. */
export async function globalCategories(siteIds: number[], database: Database = db()) {
  const brands = await brandsIn(siteIds, database);
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  const rows = brands.length
    ? await database.select().from(articleCategories).where(inArray(articleCategories.siteId, [...byId.keys()]))
    : [];
  const filed = rows.length
    ? await database
        .select({ categoryId: articles.categoryId, n: count() })
        .from(articles)
        .where(inArray(articles.categoryId, rows.map((row) => row.id)))
        .groupBy(articles.categoryId)
    : [];
  const articlesIn = new Map(filed.map((row) => [row.categoryId, Number(row.n)]));

  return byName(
    rows.map((row) => ({ brand: byId.get(row.siteId)!, row })),
    (row) => row.name,
    brands.length,
  ).map((group) => ({
    name: group.name,
    of: group.of,
    brands: group.copies
      .map(({ brand, row }) => ({ slug: brand.slug, name: brand.name, articles: articlesIn.get(row.id) ?? 0 }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  }));
}

/** Add a category to the ticked brands that lack it; rename it where they have it. The slug never moves. */
export async function applyCategory(
  guard: Guarded,
  input: { name: string; new_name?: string; sort_order?: unknown; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ created: number; updated: number }> {
  const brands = await ticked(guard, input.sites, database);
  const to = String(input.new_name ?? "").trim() || String(input.name ?? "").trim();

  if (to === "") {
    throw new AccountError("Give the category a name.", 422, "new_name");
  }

  const rows = await database
    .select()
    .from(articleCategories)
    .where(inArray(articleCategories.siteId, brands.map((brand) => brand.id)));
  const plan = brands.map((brand) => ({
    brand,
    existing: rows.find((row) => row.siteId === brand.id && sameName(row.name, input.name)),
  }));

  for (const { brand, existing } of plan) {
    await requirePermission(guard, brand.id, existing ? "category-edit" : "category-create", database);

    if (rows.some((row) => row.siteId === brand.id && row.id !== existing?.id && sameName(row.name, to))) {
      throw new AccountError(`${brand.name} already has a category called "${to}".`, 409, "new_name");
    }
  }

  // A position, when one is given, is set on every ticked brand; blank keeps each brand's own.
  const position = String(input.sort_order ?? "").trim();
  const sortOrder = position !== "" && Number.isInteger(Number(position)) ? Number(position) : undefined;

  for (const { brand, existing } of plan) {
    await saveCategory(
      guard,
      existing
        ? { id: existing.id, name: to, sort_order: sortOrder ?? existing.sortOrder }
        : { site: brand.slug, name: to, sort_order: sortOrder },
      context,
      database,
    );
  }

  const created = plan.filter((step) => !step.existing).length;

  return { created, updated: plan.length - created };
}

/** Remove a category from the ticked brands; a brand with articles filed under it keeps it and is named back. */
export async function removeCategory(
  guard: Guarded,
  input: { name: string; sites: unknown[] },
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ removed: number; kept: string[] }> {
  const brands = await ticked(guard, input.sites, database);
  const rows = await database
    .select()
    .from(articleCategories)
    .where(inArray(articleCategories.siteId, brands.map((brand) => brand.id)));
  const kept: string[] = [];
  let removed = 0;

  for (const brand of brands) {
    const existing = rows.find((row) => row.siteId === brand.id && sameName(row.name, input.name));

    if (!existing) {
      continue;
    }

    try {
      removed += (await deleteCategory(guard, existing.id, context, database)) ? 1 : 0;
    } catch (error) {
      if (error instanceof AccountError && error.status === 409) {
        kept.push(brand.slug);
      } else {
        throw error;
      }
    }
  }

  return { removed, kept };
}
