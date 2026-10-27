"use server";

/**
 * Saving and deleting a page or a category. Thin: the rules are in
 * `domain/content/pages.ts` and `domain/content/categories.ts`.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { deletePage, savePage } from "@/domain/content/pages";
import { deleteCategory, saveCategory } from "@/domain/content/categories";
import { callerIp } from "./actions";

export type ContentResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const idOf = (form: FormData) => (text(form, "id") === "" ? undefined : Number(form.get("id")));

function failed(error: unknown, what: string): ContentResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not save ${what}`, { error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function savePageAction(_state: unknown, form: FormData): Promise<ContentResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = idOf(form);
  let savedId: number;

  try {
    const saved = await savePage(
      viewer,
      {
        id,
        site: slug,
        title: text(form, "title"),
        slug: text(form, "slug"),
        // The body is kept exactly as typed: it is HTML, and its spacing is the editor's.
        body: String(form.get("body") ?? ""),
        visible: form.get("visible") === "on",
      },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That page is not yours to change." };
    }

    savedId = saved.id;
  } catch (error) {
    return failed(error, "a page");
  }

  revalidatePath(`/dashboard/sites/${slug}/pages`);

  if (id === undefined) {
    redirect(`/dashboard/sites/${slug}/pages/${savedId}?saved=1`);
  }

  revalidatePath(`/dashboard/sites/${slug}/pages/${savedId}`);

  return { saved: "Saved." };
}

export async function deletePageAction(_state: unknown, form: FormData): Promise<ContentResult> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    if (!(await deletePage(viewer, Number(form.get("id")), { ip: await callerIp() }))) {
      return { error: "That page is not yours to change." };
    }
  } catch (error) {
    return failed(error, "a page");
  }

  revalidatePath(`/dashboard/sites/${slug}/pages`);
  redirect(`/dashboard/sites/${slug}/pages`);
}

export async function saveCategoryAction(_state: unknown, form: FormData): Promise<ContentResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = idOf(form);

  try {
    const saved = await saveCategory(
      viewer,
      { id, site: slug, name: text(form, "name"), sort_order: text(form, "sort_order") },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That category is not yours to change." };
    }
  } catch (error) {
    return failed(error, "a category");
  }

  revalidatePath(`/dashboard/sites/${slug}/categories`);

  return { saved: id === undefined ? "Added." : "Saved." };
}

export async function deleteCategoryAction(_state: unknown, form: FormData): Promise<ContentResult> {
  const viewer = await staff();
  const slug = text(form, "site");

  try {
    if (!(await deleteCategory(viewer, Number(form.get("id")), { ip: await callerIp() }))) {
      return { error: "That category is not yours to change." };
    }
  } catch (error) {
    return failed(error, "a category");
  }

  revalidatePath(`/dashboard/sites/${slug}/categories`);

  return { saved: "Deleted." };
}
