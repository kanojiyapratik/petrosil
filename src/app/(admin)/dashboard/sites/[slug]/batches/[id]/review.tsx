"use client";

/** The "Run analysis" button. One model call: a few seconds, sometimes a minute. */

import { useActionState } from "react";

import { reviewAction, type RollBackState } from "./actions";

export function RunReview({ slug, batch, again }: { slug: string; batch: number; again: boolean }) {
  const [state, action, pending] = useActionState(reviewAction, null as RollBackState);

  return (
    <form action={action} className="actions" style={{ alignItems: "center", margin: 0 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="batch" value={batch} />
      <button type="submit" className={`small${again ? " ghost" : ""}`} disabled={pending}>
        {pending ? "The AI is reading the batch…" : again ? "Run again" : "Run analysis"}
      </button>
      {state?.error ? <span className="small bad">{state.error}</span> : null}
    </form>
  );
}
