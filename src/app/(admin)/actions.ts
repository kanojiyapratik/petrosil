"use server";

/**
 * The two things the shell itself does.
 *
 * Both go through the same `signIn`/`signOut` the API routes use. A server
 * action that reimplemented the throttle, the attempt log or the cookie
 * would be a second front door with its own locks.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE, SignInError, sessionCookie, signIn, signOut as endSession } from "@/lib/auth/session";
import { DEV_PASSWORD, quickSignInHere } from "@/lib/auth/dev-sign-in";

export async function signInAction(_state: unknown, form: FormData) {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  let token: string;
  let expiresAt: Date;

  try {
    const result = await signIn({ email, password });
    token = result.token;
    expiresAt = result.expiresAt;
  } catch (error) {
    if (error instanceof SignInError) {
      return { error: error.message };
    }

    console.error("sign-in failed", { error });

    return { error: "Something went wrong. Try again." };
  }

  const jar = await cookies();

  jar.set(sessionCookie(token, expiresAt));

  // Outside the try: redirect() works by throwing, so catching around it
  // would swallow the redirect and report it as a failed sign-in.
  redirect("/dashboard");
}

/**
 * Sign in as one of the local accounts, from a button.
 *
 * It is not a second way in. The email arrives from the form and the
 * password is the development one, and both go through the same `signIn`
 * everything else uses — so the throttle still throttles, the attempt is
 * still written to the login log, and the session is an ordinary session
 * that signing out revokes.
 *
 * The gate is checked here as well as on the page. The page deciding not to
 * draw a button is not a reason for the action behind it to work.
 */
export async function quickSignIn(form: FormData) {
  if (!quickSignInHere()) {
    throw new Error("one-click sign-in is not available here");
  }

  const email = String(form.get("email") ?? "");

  let token: string;
  let expiresAt: Date;

  try {
    const result = await signIn({ email, password: DEV_PASSWORD });
    token = result.token;
    expiresAt = result.expiresAt;
  } catch (error) {
    // Nothing is reported back to the caller: these buttons exist because the
    // account and its password are known, so a failure here is a broken
    // development machine rather than something a person should be told
    // about on a sign-in form.
    console.error("one-click sign-in failed", { email, error });
    redirect("/sign-in?quick=failed");
  }

  const jar = await cookies();

  jar.set(sessionCookie(token, expiresAt));

  redirect("/dashboard");
}

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;

  if (token) {
    await endSession(token);
  }

  jar.delete(COOKIE);
  redirect("/sign-in");
}
