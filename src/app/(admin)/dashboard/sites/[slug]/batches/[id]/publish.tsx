"use client";

/** A draft update's two ways out: publish it, or throw it away. */

import { useActionState } from "react";

import { commitAction, discardAction, type RollBackState } from "./actions";

export function Publish({ slug, batch, rows }: { slug: string; batch: number; rows: number }) {
  const [committed, commit, committing] = useActionState(commitAction, null as RollBackState);
  const [discarded, discard, discarding] = useActionState(discardAction, null as RollBackState);
  const state = committed ?? discarded;
  const busy = committing || discarding;

  return (
    <div className="actions" style={{ alignItems: "center" }}>
      <form
        action={commit}
        onSubmit={(event) => {
          if (!window.confirm(`Publish batch #${batch}? Its ${rows} included price${rows === 1 ? "" : "s"} go on the website.`)) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="batch" value={batch} />
        <button type="submit" className="small" disabled={busy}>
          {committing ? "Publishing…" : "Commit to the website"}
        </button>
      </form>
      <form
        action={discard}
        onSubmit={(event) => {
          if (!window.confirm(`Discard batch #${batch}? Nothing in it will be published.`)) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="batch" value={batch} />
        <button type="submit" className="ghost small" disabled={busy}>
          {discarding ? "Discarding…" : "Discard"}
        </button>
      </form>
      {state?.error ? <div className="small bad">{state.error}</div> : state?.done ? <div className="small muted">{state.done}</div> : null}
    </div>
  );
}
