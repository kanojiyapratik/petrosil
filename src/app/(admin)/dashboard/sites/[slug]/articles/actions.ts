"use server";

/**
 * Writing an article.
 *
 * Thin wrappers, as everywhere else in this admin: each one hands the
 * decision to the same `createArticle` / `updateArticle` / `withdrawArticle`
 * the API routes call, so the brand check, the slug, the publish stamp and
 * the audit entry all happen in one place rather than twice.
 *
 * `AccountError` is what the domain raises for anything an editor can fix —
 * an empty title, a category from another brand — so it comes back as a
 * message on the form rather than a stack trace.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccountError } from "@/domain/accounts/register";
import { createArticle, updateArticle, withdrawArticle } from "@/domain/content/articles";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type ArticleFormResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

/** A checkbox posts "on" or nothing at all; an absent box is false, not unset. */
const ticked = (form: FormData, name: string) => form.get(name) === "on";

/** An empty select or text field means "nothing", not "leave it alone". */
function text(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

function categoryFrom(form: FormData): number | null {
  const raw = text(form, "category_id");
  const id = Number(raw);

  return raw !== "" && Number.isInteger(id) ? id : null;
}

/** The brand the form named, for the paths this action has to revalidate. */
function slugFrom(form: FormData): string {
  return String(form.get("site") ?? "").trim();
}

export async function createArticleAction(
  _state: unknown,
  form: FormData,
): Promise<ArticleFormResult> {
  const viewer = await staff();
  const slug = slugFrom(form);

  let id: number;

  try {
    const made = await createArticle(
      viewer,
      {
        site: text(form, "site"),
        title: text(form, "title"),
        excerpt: text(form, "excerpt") || null,
        body: String(form.get("body") ?? ""),
        hero_image: text(form, "hero_image") || null,
        premium_only: ticked(form, "premium_only"),
        category_id: categoryFrom(form),
      },
      { ip: await callerIp() },
    );

    id = made.id;
  } catch (error) {
    if (error instanceof AccountError) {
      return { error: error.message, field: error.field ?? undefined };
    }

    console.error("could not create an article", { error });

    return { error: "Something went wrong. Nothing was saved." };
  }

  revalidatePath(`/dashboard/sites/${slug}/articles`);

  // Outside the try: redirect() works by throwing, and catching around it
  // would report a successful save as a failure.
  redirect(`/dashboard/sites/${slug}/articles/${id}`);
}

/**
 * Save, publish or unpublish — one action, because they are one form.
 *
 * Which it is comes from the button pressed. Publishing is not a separate
 * screen: an editor who has just fixed a sentence should not have to save it
 * and then find a second control to put it out.
 */
export async function saveArticleAction(
  _state: unknown,
  form: FormData,
): Promise<ArticleFormResult> {
  const viewer = await staff();
  const slug = slugFrom(form);
  const id = Number(form.get("id"));
  const intent = text(form, "intent");

  const status =
    intent === "publish" ? "published" : intent === "unpublish" ? "draft" : undefined;

  try {
    const saved = await updateArticle(
      viewer,
      id,
      {
        title: text(form, "title"),
        excerpt: text(form, "excerpt") || null,
        body: String(form.get("body") ?? ""),
        hero_image: text(form, "hero_image") || null,
        premium_only: ticked(form, "premium_only"),
        category_id: categoryFrom(form),
        ...(status ? { status } : {}),
      },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That article is not yours to change." };
    }
  } catch (error) {
    if (error instanceof AccountError) {
      return { error: error.message, field: error.field ?? undefined };
    }

    console.error("could not save an article", { id, error });

    return { error: "Something went wrong. Nothing was saved." };
  }

  revalidatePath(`/dashboard/sites/${slug}/articles/${id}`);
  revalidatePath(`/dashboard/sites/${slug}/articles`);

  return {
    saved:
      status === "published"
        ? "Published."
        : status === "draft"
          ? "Taken back to a draft."
          : "Saved.",
  };
}

/** Withdraw, not destroy: the row stays and every link to it still resolves. */
export async function withdrawArticleAction(form: FormData) {
  const viewer = await staff();
  const slug = slugFrom(form);
  const id = Number(form.get("id"));

  await withdrawArticle(viewer, id, { ip: await callerIp() });

  revalidatePath(`/dashboard/sites/${slug}/articles`);
  redirect(`/dashboard/sites/${slug}/articles`);
}
