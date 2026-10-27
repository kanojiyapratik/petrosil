"use server";

/** Writing an offer. The rules are in `domain/offers/editor.ts`. */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { createOffer, updateOffer, withdrawOffer } from "@/domain/offers/editor";
import { callerIp } from "@/app/(admin)/dashboard/actions";

export type OfferFormResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

const FIELDS = [
  "subject",
  "offer_type",
  "status",
  "keywords",
  "description",
  "contact_person",
  "contact_email",
  "contact_phone",
  "company_name",
  "city",
  "state",
  "country",
  "offer_value",
  "image",
  "file",
  "poster_email",
] as const;

const fields = (form: FormData) => Object.fromEntries(FIELDS.map((name) => [name, text(form, name)]));

function failed(error: unknown, what: string, detail: Record<string, unknown>): OfferFormResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not ${what} an offer`, { ...detail, error });

  return { error: "Something went wrong. Nothing was saved." };
}

export async function createOfferAction(_state: unknown, form: FormData): Promise<OfferFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  let id: number;

  try {
    id = (await createOffer(viewer, { site: slug, ...fields(form) }, { ip: await callerIp() })).id;
  } catch (error) {
    return failed(error, "create", { slug });
  }

  revalidatePath(`/dashboard/sites/${slug}/offers`);
  redirect(`/dashboard/sites/${slug}/offers/${id}?saved=1`);
}

export async function saveOfferAction(_state: unknown, form: FormData): Promise<OfferFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  try {
    if (!(await updateOffer(viewer, id, fields(form), { ip: await callerIp() }))) {
      return { error: "That offer is not yours to change." };
    }
  } catch (error) {
    return failed(error, "save", { id });
  }

  revalidatePath(`/dashboard/sites/${slug}/offers/${id}`);
  revalidatePath(`/dashboard/sites/${slug}/offers`);

  return { saved: "Saved." };
}

export async function withdrawOfferAction(_state: unknown, form: FormData): Promise<OfferFormResult> {
  const viewer = await staff();
  const slug = text(form, "site");
  const id = Number(form.get("id"));

  try {
    if (!(await withdrawOffer(viewer, id, { ip: await callerIp() }))) {
      return { error: "That offer is not yours to change." };
    }
  } catch (error) {
    return failed(error, "withdraw", { id });
  }

  revalidatePath(`/dashboard/sites/${slug}/offers`);
  redirect(`/dashboard/sites/${slug}/offers`);
}
