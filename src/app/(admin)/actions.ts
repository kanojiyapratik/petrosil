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

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;

  if (token) {
    await endSession(token);
  }

  jar.delete(COOKIE);
  redirect("/sign-in");
}
