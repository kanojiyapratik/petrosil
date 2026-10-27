/**
 * Newsletter templates: the layouts a new issue is composed from.
 *
 * A template is HTML with placeholders. Composing an issue fills four of
 * them with the brand's latest items and empties every other one — the old
 * customer lists ({premium_user}, {latest_user}) on purpose, and the old ad
 * blocks because their images lived on the old hosts. So saving a template
 * reports which of its placeholders will come out empty, rather than leaving
 * an editor to find out from a sent issue.
 *
 * A template an issue was composed from cannot be deleted, only switched
 * off: the issue's record names it.
 */

import { and, count, eq, ne, sql } from "drizzle-orm";

import { db, type Database } from "@/db";
import { auditLog, newsletterTemplates, newsletters, sites } from "@/db/schema";
import type { Guarded } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { requirePermission } from "@/domain/staff/permissions";

/** What composing an issue fills. Keep in step with `composeNewsletter`. */
export const FILLED_PLACEHOLDERS = ["articles", "report", "offers", "impex-data"] as const;

/** The placeholders in a body that composing will leave empty, in order of first use. */
export function unfilledPlaceholders(body: string): string[] {
  const names = [...body.matchAll(/\{([a-z_-]+)\}/g)].map((match) => match[1]!);

  return [...new Set(names)].filter((name) => !(FILLED_PLACEHOLDERS as readonly string[]).includes(name));
}

export type TemplateInput = { id?: number; site?: string; title: unknown; body: unknown; enabled: boolean };

export async function saveTemplate(
  guard: Guarded,
  input: TemplateInput,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<{ id: number; unfilled: string[] }> {
  let existing: typeof newsletterTemplates.$inferSelect | undefined;
  let siteId: number;

  if (input.id !== undefined) {
    [existing] = await database.select().from(newsletterTemplates).where(eq(newsletterTemplates.id, input.id)).limit(1);

    // Another brand's template answers the same as no template.
    if (!existing || (!guard.isSuperadmin && !guard.siteIds.includes(existing.siteId))) {
      throw new AccountError("We cannot find that template.", 404);
    }

    siteId = existing.siteId;
    await requirePermission(guard, siteId, "template-edit", database);
  } else {
    const [brand] = await database.select().from(sites).where(eq(sites.slug, String(input.site ?? ""))).limit(1);

    if (!brand) {
      throw new AccountError("We do not recognise that brand.", 422, "site");
    }

    if (!guard.isSuperadmin && !guard.siteIds.includes(brand.id)) {
      throw new AccountError("You do not have access to that brand.", 403, "site");
    }

    siteId = brand.id;
    await requirePermission(guard, siteId, "template-create", database);
  }

  const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, 191);
  const body = String(input.body ?? "");

  if (title === "") {
    throw new AccountError("Give the template a name.", 422, "title");
  }

  if (body.trim() === "") {
    throw new AccountError("A template needs its layout.", 422, "body");
  }

  const [clash] = await database
    .select({ id: newsletterTemplates.id })
    .from(newsletterTemplates)
    .where(
      and(
        eq(newsletterTemplates.siteId, siteId),
        sql`lower(${newsletterTemplates.title}) = ${title.toLowerCase()}`,
        existing ? ne(newsletterTemplates.id, existing.id) : undefined,
      ),
    )
    .limit(1);

  if (clash) {
    throw new AccountError("This brand already has a template by that name.", 409, "title");
  }

  const values = { title, body, enabled: input.enabled, updatedAt: new Date() };
  const [row] = existing
    ? await database.update(newsletterTemplates).set(values).where(eq(newsletterTemplates.id, existing.id)).returning()
    : await database.insert(newsletterTemplates).values({ ...values, siteId }).returning();

  const unfilled = unfilledPlaceholders(body);

  await database.insert(auditLog).values({
    siteId,
    userId: guard.identity.user.id,
    action: existing ? "newsletter-template.update" : "newsletter-template.create",
    entity: "newsletter_template",
    entityId: row!.id,
    detail: { title, enabled: input.enabled, unfilled },
    ip: context.ip ?? null,
  });

  return { id: row!.id, unfilled };
}

/** False when it is another brand's; refused once an issue was composed from it. */
export async function deleteTemplate(
  guard: Guarded,
  id: number,
  context: { ip?: string | null } = {},
  database: Database = db(),
): Promise<boolean> {
  const [found] = await database.select().from(newsletterTemplates).where(eq(newsletterTemplates.id, id)).limit(1);

  if (!found || (!guard.isSuperadmin && !guard.siteIds.includes(found.siteId))) {
    return false;
  }

  await requirePermission(guard, found.siteId, "template-delete", database);

  const [used] = await database.select({ n: count() }).from(newsletters).where(eq(newsletters.templateId, id));

  if ((used?.n ?? 0) > 0) {
    throw new AccountError(
      `${used!.n} issue${used!.n === 1 ? " was" : "s were"} composed from it, so it can only be switched off.`,
      409,
    );
  }

  await database.delete(newsletterTemplates).where(eq(newsletterTemplates.id, id));

  await database.insert(auditLog).values({
    siteId: found.siteId,
    userId: guard.identity.user.id,
    action: "newsletter-template.delete",
    entity: "newsletter_template",
    entityId: id,
    // The layout goes in the trail, so a template deleted by mistake can be put back.
    detail: { title: found.title, body: found.body },
    ip: context.ip ?? null,
  });

  return true;
}

export async function templateForEdit(siteIds: number[], id: number, database: Database = db()) {
  const [row] = await database
    .select({ template: newsletterTemplates, slug: sites.slug, name: sites.name })
    .from(newsletterTemplates)
    .innerJoin(sites, eq(sites.id, newsletterTemplates.siteId))
    .where(eq(newsletterTemplates.id, id))
    .limit(1);

  if (!row || (siteIds.length > 0 && !siteIds.includes(row.template.siteId))) {
    return null;
  }

  const [used] = await database.select({ n: count() }).from(newsletters).where(eq(newsletters.templateId, id));

  return {
    id: row.template.id,
    site: row.slug,
    site_name: row.name,
    title: row.template.title,
    body: row.template.body,
    enabled: row.template.enabled,
    used_by: Number(used?.n ?? 0),
    unfilled: unfilledPlaceholders(row.template.body),
    updated_at: row.template.updatedAt.toISOString(),
  };
}

export type TemplateForEdit = NonNullable<Awaited<ReturnType<typeof templateForEdit>>>;
