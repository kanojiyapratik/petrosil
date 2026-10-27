"use client";

/**
 * The report form, for a new report and an existing one.
 *
 * Choosing a PDF or a cover uploads it straight away, to the same upload
 * route the Files screen uses, and puts the stored name in the form. The
 * report is not changed until Save, so a wrong upload costs nothing but a
 * stray file.
 */

import { useActionState, useState } from "react";
import Link from "next/link";

import type { ReportForEdit } from "@/domain/reports/editor";
import {
  createReportAction,
  saveReportAction,
  withdrawReportAction,
  type ReportFormResult,
} from "./actions";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft: not on the site",
  published: "Open to everyone",
  premium: "Subscribers only: everyone sees the description, subscribers get the file",
};

function Flash({ state }: { state: ReportFormResult }) {
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

/** A stored file name, with an upload that replaces it. */
function Attachment(props: {
  site: string;
  name: "file" | "thumbnail";
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

export function ReportForm({
  slug,
  types,
  report,
}: {
  slug: string;
  types: string[];
  report?: ReportForEdit;
}) {
  const editing = report !== undefined;
  const [state, action, pending] = useActionState(
    editing ? saveReportAction : createReportAction,
    null as ReportFormResult,
  );

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {editing ? <input type="hidden" name="id" value={report.id} /> : null}

      <Flash state={state} />

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The report</h2>
          </div>
          <div className="body">
            <div className="field">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                name="title"
                type="text"
                required
                maxLength={255}
                autoFocus={!editing}
                defaultValue={report?.title ?? ""}
                aria-invalid={state?.field === "title" || undefined}
              />
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea id="description" name="description" rows={10} defaultValue={report?.description ?? ""} />
              <div className="small muted">Shown to everyone, including on a subscribers-only report.</div>
            </div>

            <Attachment
              site={slug}
              name="file"
              folder="reports/files"
              label="PDF"
              accept="application/pdf,.pdf"
              initial={report?.file ?? null}
              initialId={report?.file_id ?? null}
              invalid={state?.field === "file"}
            />

            <Attachment
              site={slug}
              name="thumbnail"
              folder="reports/thumbnail"
              label="Cover picture"
              accept="image/*"
              initial={report?.thumbnail ?? null}
              initialId={report?.thumbnail_id ?? null}
              invalid={state?.field === "thumbnail"}
            />
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="head">
              <h2>Filing</h2>
            </div>
            <div className="body">
              {editing ? (
                <dl className="kv">
                  <dt>Brand</dt>
                  <dd>{report.site_name}</dd>
                  <dt>Address</dt>
                  <dd>
                    <code>/{report.slug}</code>
                  </dd>
                  <dt>Opened</dt>
                  <dd>{report.clicks.toLocaleString("en-IN")}</dd>
                </dl>
              ) : null}

              <div className="field">
                <label htmlFor="status">Who can read it</label>
                <select
                  id="status"
                  name="status"
                  defaultValue={report?.status ?? "draft"}
                  aria-invalid={state?.field === "status" || undefined}
                >
                  {Object.entries(STATUS_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="report_type">Kind</label>
                <input
                  id="report_type"
                  name="report_type"
                  type="text"
                  list="report-types"
                  required
                  maxLength={64}
                  defaultValue={report?.report_type ?? "report"}
                />
                <datalist id="report-types">
                  {types.map((type) => (
                    <option key={type} value={type} />
                  ))}
                </datalist>
              </div>

              <div className="field">
                <label htmlFor="authored_on">Dated</label>
                <input
                  id="authored_on"
                  name="authored_on"
                  type="date"
                  defaultValue={report?.authored_on ?? ""}
                  aria-invalid={state?.field === "authored_on" || undefined}
                />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>Search engines</h2>
            </div>
            <div className="body">
              <div className="field">
                <label htmlFor="meta_title">Page title</label>
                <input id="meta_title" name="meta_title" type="text" maxLength={255} defaultValue={report?.meta_title ?? ""} />
              </div>
              <div className="field">
                <label htmlFor="meta_description">Page description</label>
                <textarea
                  id="meta_description"
                  name="meta_description"
                  rows={3}
                  maxLength={2000}
                  defaultValue={report?.meta_description ?? ""}
                />
              </div>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save" : "Create report"}
            </button>
            <Link className="button ghost" href={`/dashboard/sites/${slug}/reports`}>
              {editing ? "Back to reports" : "Cancel"}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}

/** Outside the editing form, so a stray Enter cannot take a report down. */
export function WithdrawReport({ slug, id }: { slug: string; id: number }) {
  const [state, action, pending] = useActionState(withdrawReportAction, null as ReportFormResult);

  return (
    <form action={action} style={{ marginTop: 16 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <div className="note">
        <Flash state={state} />
        <strong>Withdraw this report.</strong> It comes off the brand site and the lists. The row and its file
        stay, so the delivery log still shows what was sent.
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="ghost small" type="submit" disabled={pending}>
            Withdraw
          </button>
        </div>
      </div>
    </form>
  );
}
