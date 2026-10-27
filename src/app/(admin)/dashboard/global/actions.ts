"use server";

/** Applying a page, a system email or a field rule to the brands ticked. The rules are in `domain/global/estate.ts`. */

import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import {
  applyCategory,
  applyEmail,
  applyField,
  applyPage,
  applySlot,
  removeCategory,
  removeSlot,
  type FieldForm,
} from "@/domain/global/estate";
import { callerIp } from "../actions";

export type GlobalResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const brands = (form: FormData) => form.getAll("site").map(String);

function failed(error: unknown): GlobalResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error("could not apply a global setting", { error });

  return { error: "Something went wrong. Nothing was saved." };
}

const applied = (result: { created: number; updated: number }) =>
  `Applied to ${result.created + result.updated} brand${result.created + result.updated === 1 ? "" : "s"}` +
  (result.created ? `, ${result.created} of them new.` : ".");

export async function applyPageAction(_state: unknown, form: FormData): Promise<GlobalResult> {
  const viewer = await staff();

  try {
    const result = await applyPage(
      viewer,
      {
        slug: text(form, "slug"),
        title: text(form, "title"),
        body: String(form.get("body") ?? ""),
        visible: form.get("visible") === "on",
        sites: brands(form),
      },
      { ip: await callerIp() },
    );

    revalidatePath("/dashboard/global/pages", "layout");

    return { saved: applied(result) };
  } catch (error) {
    return failed(error);
  }
}

export async function applyEmailAction(_state: unknown, form: FormData): Promise<GlobalResult> {
  const viewer = await staff();

  try {
    const result = await applyEmail(
      viewer,
      {
        key: text(form, "key"),
        variant: text(form, "variant"),
        subject: text(form, "subject"),
        body: String(form.get("body") ?? ""),
        enabled: form.get("enabled") === "on",
        sites: brands(form),
      },
      { ip: await callerIp() },
    );

    revalidatePath("/dashboard/global/emails", "layout");

    return { saved: applied(result) };
  } catch (error) {
    return failed(error);
  }
}

export async function applyFieldAction(_state: unknown, form: FormData): Promise<GlobalResult> {
  const viewer = await staff();

  try {
    const result = await applyField(
      viewer,
      {
        form: text(form, "form") as FieldForm,
        key: text(form, "key"),
        show_free: form.get("show_free") === "on",
        show_premium: form.get("show_premium") === "on",
        enabled: form.get("enabled") === "on",
        sites: brands(form),
      },
      { ip: await callerIp() },
    );

    revalidatePath("/dashboard/global/visibility");

    return {
      saved:
        `Applied to ${result.updated} brand${result.updated === 1 ? "" : "s"}.` +
        (result.missing.length ? ` Not on ${result.missing.join(", ")}, which have no such field.` : ""),
    };
  } catch (error) {
    return failed(error);
  }
}

const removed = (result: { removed: number; kept: string[] }, what: string) =>
  `Removed from ${result.removed} brand${result.removed === 1 ? "" : "s"}.` +
  (result.kept.length ? ` Kept on ${result.kept.join(", ")}: ${what}.` : "");

/** Apply or remove an ad slot name, by which button was pressed. */
export async function slotAction(_state: unknown, form: FormData): Promise<GlobalResult> {
  const viewer = await staff();

  try {
    if (text(form, "intent") === "remove") {
      const result = await removeSlot(viewer, { title: text(form, "title"), sites: brands(form) }, { ip: await callerIp() });

      revalidatePath("/dashboard/global/ad-slots");

      return { saved: removed(result, "ads still run in it there") };
    }

    const result = await applySlot(
      viewer,
      { title: text(form, "title"), new_title: text(form, "new_title"), enabled: form.get("enabled") === "on", sites: brands(form) },
      { ip: await callerIp() },
    );

    revalidatePath("/dashboard/global/ad-slots");

    return { saved: applied(result) };
  } catch (error) {
    return failed(error);
  }
}

/** Apply or remove a category name, by which button was pressed. */
export async function categoryAction(_state: unknown, form: FormData): Promise<GlobalResult> {
  const viewer = await staff();

  try {
    if (text(form, "intent") === "remove") {
      const result = await removeCategory(viewer, { name: text(form, "title"), sites: brands(form) }, { ip: await callerIp() });

      revalidatePath("/dashboard/global/categories");

      return { saved: removed(result, "articles are still filed under it there") };
    }

    const result = await applyCategory(
      viewer,
      { name: text(form, "title"), new_name: text(form, "new_title"), sites: brands(form) },
      { ip: await callerIp() },
    );

    revalidatePath("/dashboard/global/categories");

    return { saved: applied(result) };
  } catch (error) {
    return failed(error);
  }
}
