"use client";

/** Choose a password from an invitation link. */

import Link from "next/link";
import { useActionState } from "react";

import { setPasswordAction, type SetPasswordResult } from "./actions";

export function SetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(setPasswordAction, null as SetPasswordResult);

  if (state?.done) {
    return (
      <p className="flash" role="status">
        Your password is set. <Link href="/sign-in">Sign in</Link>.
      </p>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="token" value={token} />
      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="again">The same again</label>
        <input id="again" name="again" type="password" autoComplete="new-password" minLength={8} required />
      </div>

      <button type="submit" disabled={pending}>
        {pending ? "Setting…" : "Set my password"}
      </button>
    </form>
  );
}
