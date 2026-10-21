"use server";

/**
 * Saving a setting, and switching a paywalled field on or off.
 *
 * Both go through the domain, which refuses a key the catalogue does not
 * know — so a hand-made form post cannot invent configuration. The audit
 * entry matters here more than most places: "who changed the SMTP password"
 * was unanswerable on the old sites, where the whole table was editable by
 * anyone who could reach the screen.
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, formFields, sites, type FormKind } from "@/db/schema";
import { currentViewer } from "@/lib/auth/server";
import { saveSetting } from "@/domain/dashboard/settings";
import { callerIp } from "../actions";

async function brandFor(slug: string | null, siteIds: number[]) {
  if (!slug) {
    return null;
  }

  const [site] = await db().select().from(sites).where(eq(sites.slug, slug)).limit(1);

  if (!site || (siteIds.length > 0 && !siteIds.includes(site.id))) {
    throw new Error("not your brand");
  }

  return site;
}

export async function saveSettings(_state: unknown, form: FormData) {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const slug = String(form.get("site") ?? "").trim() || null;
  const brand = await brandFor(slug, viewer.siteIds);

  // Only a superadmin may move the estate's own defaults: a brand's staff
  // can override a setting for their brand and nothing wider.
  if (!brand && !viewer.isSuperadmin) {
    return { error: "Only a superadmin can change the estate defaults." };
  }

  const ip = await callerIp();
  let saved = 0;
  let refused = 0;

  for (const [field, raw] of form.entries()) {
    if (!field.startsWith("set:") || typeof raw !== "string") {
      continue;
    }

    const key = field.slice(4);

    // A masked secret posted back unchanged must not overwrite the real one.
    if (raw.includes("•")) {
      continue;
    }

    const result = await saveSetting(brand?.id ?? null, key, raw);

    if (result.ok) {
      saved += 1;
    } else {
      refused += 1;
    }
  }

  await db()
    .insert(auditLog)
    .values({
      userId: viewer.identity.user.id,
      siteId: brand?.id ?? null,
      action: "setting.save",
      entity: "settings",
      detail: { keys: saved, refused, scope: brand?.slug ?? "estate" },
      ip,
    });

  revalidatePath("/dashboard/settings");

  if (refused > 0) {
    return { error: `${refused} key${refused === 1 ? "" : "s"} were not recognised and ignored.` };
  }

  return { saved: `Saved ${saved} setting${saved === 1 ? "" : "s"}.` };
}

/** Flip one tier's view of one field on the directory or offer form. */
export async function toggleField(form: FormData) {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  const id = Number(form.get("id"));
  const which = String(form.get("which") ?? "");
  const to = form.get("to") === "1";
  const kind = String(form.get("form") ?? "directory") as FormKind;

  if (!["free", "premium", "enabled"].includes(which)) {
    return;
  }

  const [field] = await db().select().from(formFields).where(eq(formFields.id, id)).limit(1);

  if (!field || (viewer.siteIds.length > 0 && !viewer.siteIds.includes(field.siteId))) {
    throw new Error("not your field");
  }

  await db()
    .update(formFields)
    .set(
      which === "free"
        ? { showFree: to }
        : which === "premium"
          ? { showPremium: to }
          : { enabled: to },
    )
    .where(and(eq(formFields.id, id)));

  await db()
    .insert(auditLog)
    .values({
      userId: viewer.identity.user.id,
      siteId: field.siteId,
      action: "form-field.update",
      entity: "form_fields",
      entityId: id,
      detail: { field: field.key, which, to },
      ip: await callerIp(),
    });

  revalidatePath(kind === "offer" ? "/dashboard/settings/offers" : "/dashboard/settings/directory");
}
