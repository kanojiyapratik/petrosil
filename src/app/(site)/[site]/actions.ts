"use server";

/**
 * What a reader's forms do on a brand site: sign in and out, register, the
 * two emailed links, their own details, and buying a subscription.
 *
 * Every action goes through the same domain functions the JSON API uses, so
 * the throttle, the "same reply whether or not you have an account" rule and
 * the currency rule hold here exactly as they do there. The brand arrives as a
 * hidden field and is looked up again: a form is not evidence that the brand
 * is live.
 */

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE, SignInError, identify, sessionCookie, signIn, signOut } from "@/lib/auth/session";
import { callerIp } from "@/lib/compat/auth";
import { liveBrandBySlug } from "@/lib/public/reader";
import { AccountError, confirmEmail, register, requestPasswordReset, resetPassword } from "@/domain/accounts/register";
import { spendToken } from "@/domain/accounts/tokens";
import { changePassword, updateProfile } from "@/domain/accounts/profile";
import { placeOrder, settleOrder, type Checkout, type OrderView } from "@/domain/billing/orders";
import { requestTrial } from "@/domain/billing/trials";

export type FormState = { error?: string; field?: string; done?: string } | null;

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/** The request this action is answering, for the IP the sign-in throttle counts by. */
async function caller(): Promise<Request> {
  return new Request("http://localhost/", { headers: await headers() });
}

async function brandFrom(form: FormData) {
  const brand = await liveBrandBySlug(text(form, "site"));

  if (!brand) {
    throw new AccountError("We do not recognise that brand.", 404);
  }

  return brand;
}

async function signedIn() {
  const jar = await cookies();

  return identify(jar.get(COOKIE)?.value ?? null);
}

/** An AccountError is said to the reader; anything else is logged and apologised for. */
function failed(error: unknown, what: string): FormState {
  if (error instanceof AccountError || error instanceof SignInError) {
    return { error: error.message, field: error instanceof AccountError ? error.field : undefined };
  }

  console.error(`${what} failed`, { error });

  return { error: "Something went wrong. Try again." };
}

/**
 * Where to go after signing in: back to the page that asked, but only a page
 * on this brand. An open redirect from a sign-in form is a phishing kit.
 */
function returnTo(site: string, next: string): string {
  return next.startsWith(`/${site}/`) && !next.startsWith("//") && !next.includes("\\") ? next : `/${site}/account`;
}

export async function signInReader(_state: FormState, form: FormData): Promise<FormState> {
  let site: string;

  try {
    site = (await brandFrom(form)).slug;

    const request = await caller();
    const { token, expiresAt } = await signIn(
      { email: form.get("email"), password: form.get("password") },
      { ip: callerIp(request), userAgent: request.headers.get("user-agent") },
    );

    (await cookies()).set(sessionCookie(token, expiresAt));
  } catch (error) {
    return failed(error, "brand sign-in");
  }

  // Outside the try: redirect() works by throwing.
  redirect(returnTo(site, text(form, "next")));
}

export async function signOutReader(form: FormData): Promise<void> {
  const jar = await cookies();

  await signOut(jar.get(COOKIE)?.value ?? null);
  jar.set({ name: COOKIE, value: "", path: "/", expires: new Date(0) });

  redirect(`/${(await liveBrandBySlug(text(form, "site")))?.slug ?? ""}`);
}

export async function registerReader(_state: FormState, form: FormData): Promise<FormState> {
  try {
    await register({
      site: (await brandFrom(form)).slug,
      email: form.get("email"),
      password: form.get("password"),
      name: form.get("name"),
      company: form.get("company"),
      designation: form.get("designation"),
      phone: form.get("phone"),
      country: form.get("country"),
      city: form.get("city"),
    });

    // The same words whether or not the address was already registered.
    return { done: "Check your email — we have sent you a link to confirm your address." };
  } catch (error) {
    return failed(error, "brand register");
  }
}

export async function forgotPassword(_state: FormState, form: FormData): Promise<FormState> {
  try {
    await requestPasswordReset({ email: form.get("email"), site: (await brandFrom(form)).slug });

    return { done: "If that address has an account, a link to set a new password is on its way." };
  } catch (error) {
    return failed(error, "brand forgot-password");
  }
}

export async function setNewPassword(_state: FormState, form: FormData): Promise<FormState> {
  try {
    await brandFrom(form);
    await resetPassword({ token: form.get("token"), password: form.get("password") });

    return { done: "Your password is set. You can sign in now." };
  } catch (error) {
    return failed(error, "brand reset-password");
  }
}

/**
 * Spent by pressing a button, never by opening the page: mail scanners open
 * every link in a message, and one would otherwise confirm the address for
 * whoever typed it in.
 */
export async function confirmAddress(_state: FormState, form: FormData): Promise<FormState> {
  try {
    await brandFrom(form);

    const token = await spendToken(form.get("token"), "verify_email");

    if (!token) {
      return { error: "That link is no longer valid. Sign in and ask for a new one." };
    }

    await confirmEmail(token.userId);

    return { done: "Your email address is confirmed." };
  } catch (error) {
    return failed(error, "brand verify-email");
  }
}

export async function saveProfile(_state: FormState, form: FormData): Promise<FormState> {
  const identity = await signedIn();

  if (!identity) {
    return { error: "Your session has ended. Sign in again." };
  }

  try {
    await updateProfile(identity.user.id, {
      name: form.get("name"),
      company: form.get("company"),
      designation: form.get("designation"),
      phone: form.get("phone"),
      country: form.get("country"),
      city: form.get("city"),
      website: form.get("website"),
    });

    return { done: "Saved." };
  } catch (error) {
    return failed(error, "brand profile");
  }
}

export async function savePassword(_state: FormState, form: FormData): Promise<FormState> {
  const identity = await signedIn();

  if (!identity) {
    return { error: "Your session has ended. Sign in again." };
  }

  try {
    await changePassword(identity, { current: form.get("current"), next: form.get("next") });

    return { done: "Your password is changed. Your other devices have been signed out." };
  } catch (error) {
    return failed(error, "brand password");
  }
}

export async function askForTrial(_state: FormState, form: FormData): Promise<FormState> {
  const identity = await signedIn();

  if (!identity) {
    return { error: "Sign in to ask for a trial." };
  }

  try {
    await requestTrial(identity, { site: (await brandFrom(form)).slug, note: form.get("note") });

    return { done: "Thank you — our team will be in touch shortly." };
  } catch (error) {
    return failed(error, "brand trial");
  }
}

/* ------------------------------------------------------------------ buying */

export type Placed =
  | { ok: true; order: OrderView; checkout: Checkout | null }
  | { ok: false; error: string; field?: string };

/**
 * Place an order. A buyer whose profile names no country chooses one here,
 * and it is saved first: the server prices by the profile, never by what the
 * page happened to show.
 */
export async function placeBrandOrder(input: {
  site: string;
  plan: string;
  years: number;
  code: string;
  country: string;
}): Promise<Placed> {
  let identity = await signedIn();

  if (!identity) {
    return { ok: false, error: "Sign in to subscribe." };
  }

  try {
    if (!identity.user.country && input.country) {
      const saved = await updateProfile(identity.user.id, { country: input.country });

      identity = { ...identity, user: { ...identity.user, country: saved.country } };
    }

    const { order, checkout } = await placeOrder(identity, {
      site: input.site,
      plan: input.plan,
      years: input.years,
      code: input.code,
    });

    // A code that clears the whole price leaves nothing to pay: settle it now.
    if (order.provider === "coupon") {
      return { ok: true, order: await settleOrder(identity, order.id, {}), checkout: null };
    }

    return { ok: true, order, checkout };
  } catch (error) {
    const said = failed(error, "brand order");

    return { ok: false, error: said?.error ?? "Something went wrong.", field: said?.field };
  }
}

/** What Razorpay's checkout hands back, checked by signature before anything is granted. */
export async function settleBrandOrder(
  orderId: number,
  paid: { razorpay_payment_id: string; razorpay_signature: string },
): Promise<Placed> {
  const identity = await signedIn();

  if (!identity) {
    return { ok: false, error: "Your session has ended. Sign in again — your payment is safe." };
  }

  try {
    const request = await caller();

    return {
      ok: true,
      order: await settleOrder(identity, orderId, paid, { ip: callerIp(request) }),
      checkout: null,
    };
  } catch (error) {
    const said = failed(error, "brand settle");

    return { ok: false, error: said?.error ?? "Something went wrong." };
  }
}
