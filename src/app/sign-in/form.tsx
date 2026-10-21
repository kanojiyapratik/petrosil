"use client";

/**
 * The sign-in form.
 *
 * One message for every failure, because the action hands back whatever
 * `signIn` said and `signIn` deliberately says the same thing for a wrong
 * password and an unknown account.
 */

import { useActionState } from "react";

import { signInAction } from "../(admin)/actions";

export function SignInForm() {
  const [state, action, pending] = useActionState(signInAction, null as { error?: string } | null);

  return (
    <form action={action}>
      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
