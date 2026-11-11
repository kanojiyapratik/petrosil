"use client";

/**
 * The article form's parts that talk to the server while the form is open:
 * the cover picture, adding a category, and deleting.
 */

import { useRef, useState } from "react";

import { addCategoryAction, withdrawArticleAction } from "./actions";

/* ---------------------------------------------------------------- cover */

/**
 * The cover picture: a preview, an Upload button, and Remove. The stored
 * file name is posted as `name`; nothing changes on the article until Save.
 */
export function CoverImage({ site, name, initial }: { site: string; name: string; initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const folder = "articles/thumbnail";

  async function upload(file: File) {
    setBusy(true);
    setNote(null);

    const body = new FormData();

    body.set("site", site);
    body.set("folder", folder);
    body.set("file", file);

    try {
      const response = await fetch("/api/dashboard/files", { method: "POST", body, headers: { accept: "application/json" } });
      const result = (await response.json()) as { ok: boolean; name?: string; message?: string };

      if (result.ok && result.name) {
        setValue(result.name);
        setNote({ bad: false, text: "Uploaded. Save to use it." });
      } else {
        setNote({ bad: true, text: result.message ?? "The picture could not be uploaded." });
      }
    } catch {
      setNote({ bad: true, text: "The picture could not be uploaded. Check the connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label>Cover picture</label>
      <input type="hidden" name={name} value={value} />
      <div className="cover-pick">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/public/${site}/files/${folder}/${encodeURIComponent(value)}`} alt="The cover picture" />
        ) : (
          <div className="cover-none">No picture yet</div>
        )}
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <button type="button" className="small" disabled={busy} onClick={() => picker.current?.click()}>
          {busy ? "Uploading…" : value ? "Change picture" : "Upload picture"}
        </button>
        {value ? (
          <button
            type="button"
            className="small ghost"
            disabled={busy}
            onClick={() => {
              setValue("");
              setNote({ bad: false, text: "Removed. Save to keep the piece without a picture." });
            }}
          >
            Remove
          </button>
        ) : null}
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file) {
            void upload(file);
          }

          event.target.value = "";
        }}
      />
      <div className={`small ${note?.bad ? "bad" : "muted"}`} role={note ? "status" : undefined}>
        {note ? note.text : "Shown on the article and on its card in the lists. JPG or PNG, landscape works best."}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- category */

type Option = { id: number; name: string };

/**
 * The category list with "New category" beside it. The new one is made in a
 * popup for the brand being written for, then chosen straight away.
 */
export function CategoryPicker({
  site,
  options: initial,
  value: start,
}: {
  site: string;
  options: Option[];
  value: number | null;
}) {
  const [options, setOptions] = useState(initial);
  const [value, setValue] = useState(start === null ? "" : String(start));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  // A brand switched on a new article brings its own categories.
  const [shownFor, setShownFor] = useState(site);

  if (shownFor !== site) {
    setShownFor(site);
    setOptions(initial);
    setValue("");
  }

  async function add() {
    setBusy(true);
    setError(null);

    const made = await addCategoryAction(site, draft);

    setBusy(false);

    if (!made.ok) {
      setError(made.error);

      return;
    }

    setOptions((list) => [...list.filter((o) => o.id !== made.id), { id: made.id, name: made.name }].sort((a, b) => a.name.localeCompare(b.name)));
    setValue(String(made.id));
    setDraft("");
    dialog.current?.close();
  }

  return (
    <div className="field">
      <label htmlFor="category_id">Category</label>
      <div className="inline-pick">
        <select id="category_id" name="category_id" value={value} onChange={(event) => setValue(event.target.value)}>
          <option value="">No category</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <button type="button" className="small ghost" onClick={() => dialog.current?.showModal()}>
          + New
        </button>
      </div>

      <dialog
        ref={dialog}
        className="popup"
        aria-label="New category"
        onClick={(event) => {
          if (event.target === dialog.current) {
            dialog.current.close();
          }
        }}
      >
        <div className="popup-head">
          <h2>New category</h2>
          <button type="button" className="ghost small" aria-label="Close" onClick={() => dialog.current?.close()}>
            ✕
          </button>
        </div>
        <div className="popup-body">
          {/* Not a <form>: this sits inside the article's form, and forms cannot nest. */}
          <div className="field">
            <label htmlFor="new-category">Name</label>
            <input
              id="new-category"
              type="text"
              maxLength={191}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void add();
                }
              }}
              placeholder="e.g. Market analysis"
            />
          </div>
          {error ? (
            <p className="flash bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button type="button" disabled={busy || draft.trim() === ""} onClick={() => void add()}>
              {busy ? "Adding…" : "Add category"}
            </button>
            <button type="button" className="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/* --------------------------------------------------------------- delete */

/**
 * Delete, behind a confirmation. Its own form, outside the editing form, so
 * a stray Enter can never press it. The piece is hidden, not destroyed: it
 * can be brought back from the Deleted list.
 */
export function DeleteArticle({ id, site }: { id: number; site: string }) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <div className="note danger-zone" style={{ marginTop: 16 }}>
      <strong>Delete this article.</strong> It leaves the brand site and the article list. It is not destroyed: you can
      restore it from <em>Deleted</em> on the article list. To only hide it from readers, use <em>Take down</em> instead.
      <div className="actions" style={{ marginTop: 10 }}>
        <button type="button" className="small danger" onClick={() => dialog.current?.showModal()}>
          Delete
        </button>
      </div>

      <dialog
        ref={dialog}
        className="popup"
        aria-label="Delete this article"
        onClick={(event) => {
          if (event.target === dialog.current) {
            dialog.current.close();
          }
        }}
      >
        <div className="popup-head">
          <h2>Delete this article?</h2>
          <button type="button" className="ghost small" aria-label="Close" onClick={() => dialog.current?.close()}>
            ✕
          </button>
        </div>
        <div className="popup-body">
          <p style={{ marginTop: 0 }}>It disappears from the brand site and the article list. You can restore it later from Deleted.</p>
          <form action={withdrawArticleAction}>
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
