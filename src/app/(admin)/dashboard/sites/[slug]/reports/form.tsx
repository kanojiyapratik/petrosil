"use client";

/**
 * The report form, for a new report and an existing one.
 *
 * Choosing a PDF or a cover uploads it straight away, to the same upload
 * route the Files screen uses, and puts the stored name in the form. The
 * report is not changed until Save, so a wrong upload costs nothing but a
 * stray file.
 */

import { useActionState } from "react";
import Link from "@/lib/ui/link";

import { Attachment } from "@/app/(admin)/attachment";
import { AuthorField, type AuthorChoice } from "@/app/(admin)/content-tools";

import type { ReportForEdit } from "@/domain/reports/editor";
import {
  createReportAction,
  saveReportAction,
  
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

export function ReportForm({
  slug,
  types,
  report,
  kind,
  authors,
  me,
}: {
  slug: string;
  types: string[];
  authors: AuthorChoice[];
  /** The editor, the author a new report starts with. */
  me?: number;
  /** The kind a new report starts as: "sample" from the Sample reports screen. */
  kind?: string;
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
                  defaultValue={report?.report_type ?? kind ?? "report"}
                />
                <datalist id="report-types">
                  {types.map((type) => (
                    <option key={type} value={type} />
                  ))}
                </datalist>
              </div>

              <AuthorField authors={authors} value={report ? report.author_id : authors.some((a) => a.id === me) ? (me ?? null) : null} />

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
