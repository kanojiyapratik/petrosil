"use client";

/** A price note: correct its wording or remove it; and a form for writing one by hand. */

import { useActionState } from "react";

import { noteAction, type NoteResult } from "./actions";

function Flash({ state }: { state: NoteResult }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  return state?.saved ? (
    <p className="flash" role="status">
      {state.saved}
    </p>
  ) : null;
}

export function WriteNote({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(noteAction, null as NoteResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="intent" value="write" />
      <Flash state={state} />
      <div className="field">
        <label htmlFor="new-note">Note</label>
        <textarea id="new-note" name="summary" rows={4} required placeholder="Markets closed for Diwali; no assessment this week." />
      </div>
      <button type="submit" disabled={pending}>
        {pending ? "Publishing…" : "Publish this note"}
      </button>
    </form>
  );
}

export function NoteCard({
  slug,
  note,
}: {
  slug: string;
  note: { id: number; summary: string; source: string; batch_id: number | null; created_at: string; live: boolean };
}) {
  const [state, action, pending] = useActionState(noteAction, null as NoteResult);

  return (
    <form action={action} style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 14 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={note.id} />
      <Flash state={state} />
      <div className="bar" style={{ marginBottom: 8 }}>
        {note.live ? <span className="badge ok">on the site now</span> : <span className="badge">earlier</span>}
        <span className="tag">{note.source === "staff" ? "written by staff" : "from the price module"}</span>
        <span className="small muted">
          {new Date(note.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          {note.batch_id ? ` · price update #${note.batch_id}` : ""}
        </span>
      </div>
      <textarea name="summary" rows={3} defaultValue={note.summary} aria-label="Note text" />
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="submit" name="intent" value="correct" className="small" disabled={pending}>
          {pending ? "Saving…" : "Save correction"}
        </button>
        <button type="submit" name="intent" value="remove" className="ghost small" disabled={pending}>
          Remove
        </button>
      </div>
    </form>
  );
}
