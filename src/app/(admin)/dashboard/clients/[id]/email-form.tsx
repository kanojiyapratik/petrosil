"use client";

/**
 * Changing a member's email address, in a popup on their page. The address
 * is their sign-in, so it is a step of its own and says what goes with it.
 */

import { useActionState } from "react";

import { Popup } from "@/app/(admin)/popup";
import { changeEmailAction, type MemberResult } from "./actions";

export function ChangeEmail({ userId, email }: { userId: number; email: string }) {
  const [state, action, pending] = useActionState(changeEmailAction, null as MemberResult);

  return (
    <Popup label="Change email" title="Change email address" ghost>
      <form action={action}>
        <input type="hidden" name="user_id" value={userId} />

        {state?.error ? (
          <p className="flash bad" role="alert">
            {state.error}
          </p>
        ) : null}
        {state?.saved ? (
          <p className="flash" role="status">
            {state.saved}
          </p>
        ) : null}

        <p className="small muted" style={{ marginTop: 0 }}>
          Now <strong>{email}</strong>. They sign in with the new address from now on, and any password-reset or confirmation
          link already sent to the old one stops working.
        </p>

        <div className="field">
          <label htmlFor="change-email">New email address</label>
          <input
            id="change-email"
            name="email"
            type="email"
            required
            maxLength={191}
            autoComplete="off"
            aria-invalid={state?.field === "email" || undefined}
          />
        </div>

        <div className="actions">
          <button type="submit" disabled={pending}>
            {pending ? "Changing…" : "Change email"}
          </button>
        </div>
      </form>
    </Popup>
  );
}
