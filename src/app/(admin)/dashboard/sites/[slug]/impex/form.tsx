"use client";

/** An impex sheet: its title and description, who may read it, and the spreadsheet behind it. */

import { useActionState } from "react";
import Link from "@/lib/ui/link";

import { Attachment } from "@/app/(admin)/attachment";
import { AuthorField, type AuthorChoice } from "@/app/(admin)/content-tools";
import type { ImpexForEdit } from "@/domain/impex/editor";
import { createImpexAction, saveImpexAction,  type ImpexFormResult } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft: not on the site",
  published: "Open to everyone",
  premium: "Subscribers only: everyone sees the description, subscribers get the file",
};

function Flash({ state }: { state: ImpexFormResult }) {
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

export function ImpexForm({
  slug,
  sheet,
  authors,
  me,
}: {
  slug: string;
  sheet?: ImpexForEdit;
  authors: AuthorChoice[];
  /** The editor, the author a new sheet starts with. */
  me?: number;
}) {
  const editing = sheet !== undefined;
  const [state, action, pending] = useActionState(editing ? saveImpexAction : createImpexAction, null as ImpexFormResult);
  const bad = (field: string) => state?.field === field || undefined;

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {editing ? <input type="hidden" name="id" value={sheet.id} /> : null}

      <Flash state={state} />

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The sheet</h2>
          </div>
          <div className="body">
            <div className="field">
              <label htmlFor="title">Title</label>
              <input id="title" name="title" type="text" required maxLength={255} autoFocus={!editing} defaultValue={sheet?.title ?? ""} aria-invalid={bad("title")} />
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea id="description" name="description" rows={8} defaultValue={sheet?.description ?? ""} />
            </div>

            <Attachment
              site={slug}
              name="file"
              folder="impex/files"
              label="Spreadsheet"
              accept=".xlsx,.xls,.csv,.pdf"
              initial={sheet?.file ?? null}
              initialId={sheet?.file_id ?? null}
              invalid={state?.field === "file"}
            />
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>On the site</h2>
            </div>
            <div className="body">
              {editing ? (
                <dl className="kv" style={{ marginBottom: 14 }}>
                  <dt>Address</dt>
                  <dd>
                    <code>/{sheet.slug}</code>
                  </dd>
                  <dt>Opened</dt>
                  <dd>{sheet.clicks.toLocaleString("en-IN")}</dd>
                </dl>
              ) : null}

              <div className="field">
                <label htmlFor="status">Who can read it</label>
                <select id="status" name="status" defaultValue={sheet?.status ?? "draft"} aria-invalid={bad("status")}>
                  {Object.entries(STATUS_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <AuthorField authors={authors} value={sheet ? sheet.author_id : authors.some((a) => a.id === me) ? (me ?? null) : null} />

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="authored_on">Dated</label>
                <input id="authored_on" name="authored_on" type="date" defaultValue={sheet?.authored_on ?? ""} aria-invalid={bad("authored_on")} />
              </div>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save" : "Create sheet"}
            </button>
            <Link className="button ghost" href={`/dashboard/sites/${slug}/impex`}>
              {editing ? "Back to sheets" : "Cancel"}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}
