"use client";

/**
 * Change what one person gets on one brand.
 *
 * A form per brand rather than one form with a brand picker: the team
 * extends a single subscription at a time, and a picker would make it
 * possible to extend the wrong one by leaving the dropdown alone.
 */

import { useActionState } from "react";

import { saveMembership } from "../../actions";

type Result = { saved?: string; error?: string } | null;

export function MembershipForm({
  userId,
  brand,
}: {
  userId: number;
  brand: { slug: string; name: string; role: string; tier: string; expires_at: string | null };
}) {
  const [state, action, pending] = useActionState(saveMembership, null as Result);

  return (
    <form action={action}>
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="slug" value={brand.slug} />

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? <p className="flash" role="status">{state.saved}</p> : null}

      <div className="bar">
        <div className="field">
          <label htmlFor={`tier-${brand.slug}`}>Tier</label>
          <select id={`tier-${brand.slug}`} name="tier" defaultValue={brand.tier}>
            <option value="free">free</option>
            <option value="trial">trial</option>
            <option value="premium">premium</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor={`expires-${brand.slug}`}>Runs out</label>
          <input
            id={`expires-${brand.slug}`}
            name="expires_at"
            type="date"
            defaultValue={brand.expires_at ?? ""}
          />
        </div>

        <div className="field">
          <label htmlFor={`status-${brand.slug}`}>Account</label>
          <select id={`status-${brand.slug}`} name="status" defaultValue="active">
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </div>

        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
