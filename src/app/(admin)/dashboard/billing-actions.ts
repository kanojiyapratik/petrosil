"use server";

/**
 * Saving a plan, a coupon, and a payment taken by hand.
 *
 * Thin wrappers: the brand checks, permissions, money rules and audit
 * entries are in `domain/billing/{plans,coupons,manual}.ts`.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { currentViewer, type Viewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { AccountError } from "@/domain/accounts/register";
import { savePlan } from "@/domain/billing/plans";
import { saveCoupon } from "@/domain/billing/coupons";
import { recordPayment } from "@/domain/billing/manual";
import { callerIp } from "./actions";

export type BillingResult = { error?: string; field?: string; saved?: string } | null;

async function staff(): Promise<Viewer> {
  const viewer = await currentViewer();

  if (!viewer) {
    throw new Error("not staff");
  }

  return viewer;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function failed(error: unknown, what: string): BillingResult {
  if (error instanceof AccountError) {
    return { error: error.message, field: error.field ?? undefined };
  }

  if (error instanceof AccessError) {
    return { error: error.message };
  }

  console.error(`could not save ${what}`, { error });

  return { error: "Something went wrong. Nothing was saved." };
}

/**
 * The form posts `price_INR_1`, `sale_INR_1`, `price_USD_2` …; a blank
 * price means that term is not offered in that currency.
 */
function termsFrom(form: FormData) {
  const terms: { currency: string; years: number; amount: string; sale_amount: string }[] = [];

  for (const [name, value] of form.entries()) {
    const match = /^price_([A-Z]{3})_(d+)$/.exec(name);

    if (match && String(value).trim() !== "") {
      terms.push({
        currency: match[1]!,
        years: Number(match[2]),
        amount: String(value),
        sale_amount: text(form, `sale_${match[1]}_${match[2]}`),
      });
    }
  }

  return terms;
}

export async function savePlanAction(_state: unknown, form: FormData): Promise<BillingResult> {
  const viewer = await staff();
  const id = text(form, "id");
  let savedId: number;

  try {
    const saved = await savePlan(
      viewer,
      {
        id: id === "" ? undefined : Number(id),
        name: text(form, "name"),
        description: text(form, "description"),
        sites: form.getAll("site").map(String),
        currencies: form.getAll("currency").map(String),
        visible: form.get("visible") === "on",
        on_sale: form.get("on_sale") === "on",
        sort_order: text(form, "sort_order"),
        terms: termsFrom(form),
      },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That plan is not yours to change." };
    }

    savedId = saved.id;
  } catch (error) {
    return failed(error, "a plan");
  }

  revalidatePath("/dashboard/plans");

  if (id === "") {
    redirect(`/dashboard/plans/${savedId}?saved=1`);
  }

  revalidatePath(`/dashboard/plans/${savedId}`);

  return { saved: "Saved. Orders already placed keep the price they were placed at." };
}

export async function saveCouponAction(_state: unknown, form: FormData): Promise<BillingResult> {
  const viewer = await staff();
  const id = text(form, "id");

  try {
    const saved = await saveCoupon(
      viewer,
      {
        id: id === "" ? undefined : Number(id),
        site: text(form, "site"),
        code: text(form, "code"),
        kind: text(form, "kind"),
        value: text(form, "value"),
        currency: text(form, "currency"),
        max_redemptions: text(form, "max_redemptions"),
        starts_at: text(form, "starts_at"),
        expires_at: text(form, "expires_at"),
        enabled: form.get("enabled") === "on",
      },
      { ip: await callerIp() },
    );

    if (!saved) {
      return { error: "That code is not yours to change." };
    }
  } catch (error) {
    return failed(error, "a coupon");
  }

  revalidatePath("/dashboard/coupons");

  if (id === "") {
    redirect("/dashboard/coupons?saved=1");
  }

  revalidatePath(`/dashboard/coupons/${id}`);

  return { saved: "Saved." };
}

export async function recordPaymentAction(_state: unknown, form: FormData): Promise<BillingResult> {
  const viewer = await staff();
  const userId = Number(form.get("user_id"));

  try {
    const done = await recordPayment(
      viewer,
      {
        user_id: userId,
        site: text(form, "site"),
        plan_id: Number(form.get("plan_id")),
        years: text(form, "years"),
        amount: text(form, "amount"),
        method: text(form, "method"),
        reference: text(form, "reference"),
        paid_on: text(form, "paid_on"),
        until: text(form, "until"),
        currency: text(form, "currency"),
      },
      { ip: await callerIp() },
    );

    revalidatePath(`/dashboard/clients/${userId}`);
    revalidatePath("/dashboard/transactions");

    return { saved: `Recorded as order ${done.order_id}. Premium until ${done.until}.` };
  } catch (error) {
    return failed(error, "a payment");
  }
}
