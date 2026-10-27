"use client";

/**
 * A stored file name, with an upload beside it that replaces it.
 *
 * Choosing a file uploads it straight away, to the same route the Files
 * screen uses, into the given brand folder, and puts the stored name in the
 * field. The record is not changed until its form is saved, so a wrong
 * upload costs nothing but a stray file.
 */

import { useState } from "react";

export function Attachment(props: {
  site: string;
  /** The form field the stored name is posted as. */
  name: string;
  folder: string;
  label: string;
  accept: string;
  initial: string | null;
  /** The stored file's id, when the initial name is really in the store. */
  initialId: number | null;
  invalid: boolean;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  const [id, setId] = useState(props.initialId);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setNote(null);

    const body = new FormData();

    body.set("site", props.site);
    body.set("folder", props.folder);
    body.set("file", file);

    try {
      const response = await fetch("/api/dashboard/files", {
        method: "POST",
        body,
        headers: { accept: "application/json" },
      });
      const result = (await response.json()) as { ok: boolean; id?: number; name?: string; message?: string };

      if (result.ok && result.name) {
        setValue(result.name);
        setId(result.id ?? null);
        setNote({ bad: false, text: `Uploaded as ${result.name}. Save to attach it.` });
      } else {
        setNote({ bad: true, text: result.message ?? "The upload failed." });
      }
    } catch {
      setNote({ bad: true, text: "The upload failed. Check the connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        type="text"
        maxLength={512}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setId(null);
        }}
        aria-invalid={props.invalid || undefined}
        placeholder="none"
      />
      <input
        type="file"
        accept={props.accept}
        disabled={busy}
        aria-label={`Upload a new ${props.label.toLowerCase()}`}
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file) {
            void upload(file);
          }

          event.target.value = "";
        }}
        style={{ marginTop: 6 }}
      />
      <div className={`small ${note?.bad ? "bad" : "muted"}`} role={note ? "status" : undefined}>
        {busy
          ? "Uploading…"
          : note
            ? note.text
            : id
              ? (
                  <a href={`/api/dashboard/files/${id}`} target="_blank" rel="noreferrer">
                    Open the stored file
                  </a>
                )
              : value
                ? "Not in this brand's file store: readers would get a dead link. Upload it again."
                : "Upload a file, or type the name of one already in this brand's folder."}
      </div>
    </div>
  );
}

