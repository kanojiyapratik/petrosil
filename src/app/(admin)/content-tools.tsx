"use client";

/**
 * Pieces every content editor shares: reports, offers and impex sheets each
 * have an author, a link to the piece on the brand site, and a soft delete
 * that asks first and can be undone from the Deleted list.
 */

import { useRef } from "react";

export type AuthorChoice = { id: number; name: string; email: string };

/** Who wrote it. Blank is allowed: some pieces are signed by the brand. */
export function AuthorField({ authors, value }: { authors: AuthorChoice[]; value: number | null }) {
  return (
    <div className="field">
      <label htmlFor="author_id">Author</label>
      <select id="author_id" name="author_id" defaultValue={value ?? ""}>
        <option value="">No author shown</option>
        {authors.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
            {authors.filter((other) => other.name === person.name).length > 1 ? ` (${person.email})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Delete, softly, after a yes. The piece leaves the brand site and the list
 * and waits under Deleted, where Restore brings it back as it was.
 */
export function ConfirmDelete({
  action,
  id,
  site,
  noun,
  list,
}: {
  action: (form: FormData) => void | Promise<void>;
  id: number;
  site: string;
  /** "report", "offer", "impex sheet". */
  noun: string;
  /** The list it is restored from: "Reports". */
  list: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <div className="note danger-zone" style={{ marginTop: 16 }}>
      <strong>Delete this {noun}.</strong> It leaves the brand site and the list. It is not destroyed: you can restore it
      from <em>Deleted</em> on {list}.
      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="small danger" onClick={() => dialog.current?.showModal()}>
          Delete
        </button>
      </div>

      <dialog
        ref={dialog}
        className="popup"
        aria-label={`Delete this ${noun}`}
        onClick={(event) => {
          if (event.target === dialog.current) {
            dialog.current.close();
          }
        }}
      >
        <div className="popup-head">
          <h2>Delete this {noun}?</h2>
          <button type="button" className="ghost small" aria-label="Close" onClick={() => dialog.current?.close()}>
            ✕
          </button>
        </div>
        <div className="popup-body">
          <p style={{ marginTop: 0 }}>
            It disappears from the brand site and {list}. You can restore it later from Deleted.
          </p>
          <form action={action}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="site" value={site} />
            <div className="actions">
              <button type="submit" className="danger">
                Yes, delete it
              </button>
              <button type="button" className="ghost" onClick={() => dialog.current?.close()}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </div>
  );
}
