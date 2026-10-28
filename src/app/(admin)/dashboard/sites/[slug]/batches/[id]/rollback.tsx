"use client";

/** The one action on a committed update: take it back. */

import { useActionState } from "react";

import { rollBackAction, type RollBackState } from "./actions";

export function RollBack({ slug, batch, rows }: { slug: string; batch: number; rows: number }) {
  const [state, action, pending] = useActionState(rollBackAction, null as RollBackState);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`Roll back batch #${batch}? Its ${rows} published figure${rows === 1 ? "" : "s"} go back to what they were.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="batch" value={batch} />
      <button type="submit" className="ghost small" disabled={pending}>
        {pending ? "Rolling back…" : "Roll back"}
      </button>
      {state?.error ? <div className="small bad">{state.error}</div> : state?.done ? <div className="small muted">{state.done}</div> : null}
    </form>
  );
}
