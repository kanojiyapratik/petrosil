"use client";

/**
 * A newsletter template: its name, its HTML layout, and whether it is offered
 * when composing an issue. The preview is a sandboxed frame, so nothing in a
 * template can run script in the admin.
 */

import { useActionState, useState } from "react";
import Link from "next/link";

import type { TemplateForEdit } from "@/domain/content/newsletter-templates";
import { deleteTemplateAction, saveTemplateAction, type TemplateFormResult } from "./actions";

const FILLED = ["articles", "report", "offers", "impex-data"];

function Flash({ state }: { state: TemplateFormResult }) {
  return (
    <>
      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <p className="flash" role="status">
          {state.saved}
        </p>
      ) : null}
      {state?.warning ? <p className="note">{state.warning}</p> : null}
    </>
  );
}

export function TemplateForm({ slug, template }: { slug: string; template?: TemplateForEdit }) {
  const [state, action, pending] = useActionState(saveTemplateAction, null as TemplateFormResult);
  const [body, setBody] = useState(template?.body ?? "");
  const bad = (field: string) => state?.field === field || undefined;

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {template ? <input type="hidden" name="id" value={template.id} /> : null}

      <Flash state={state} />

      <div className="cols">
        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>The template</h2>
            </div>
            <div className="body">
              <div className="bar" style={{ marginBottom: 14 }}>
                <div className="field grow">
                  <label htmlFor="title">Name</label>
                  <input id="title" name="title" type="text" required maxLength={191} defaultValue={template?.title ?? ""} aria-invalid={bad("title")} />
                </div>
                <label className="check" style={{ marginBottom: 8 }}>
                  <input type="checkbox" name="enabled" defaultChecked={template?.enabled ?? true} />
                  Offered when composing
                </label>
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="body">Layout (HTML)</label>
                <textarea
                  id="body"
                  name="body"
                  className="code"
                  rows={28}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  aria-invalid={bad("body")}
                />
                <div className="small muted">
                  Filled when an issue is composed: {FILLED.map((name) => `{${name}}`).join(" ")}. Any other placeholder
                  comes out empty.
                </div>
              </div>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : template ? "Save" : "Create template"}
            </button>
            <Link className="button ghost" href={`/dashboard/sites/${slug}/templates`}>
              {template ? "Back to templates" : "Cancel"}
            </Link>
          </div>
        </div>

        <div className="panel">
          <div className="head">
            <h2>Preview</h2>
            <span className="spacer" />
            <span className="hint">Placeholders shown as typed.</span>
          </div>
          <div className="body">
            <iframe
              title="Template preview"
              sandbox=""
              srcDoc={body}
              style={{ width: "100%", height: 760, border: "1px solid var(--line, #ddd)", background: "#fff" }}
            />
          </div>
        </div>
      </div>
    </form>
  );
}

/** Outside the editing form, so a stray Enter cannot delete a template. */
export function DeleteTemplate({ slug, id, usedBy }: { slug: string; id: number; usedBy: number }) {
  const [state, action, pending] = useActionState(deleteTemplateAction, null as TemplateFormResult);

  return (
    <form action={action} style={{ marginTop: 16 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <div className="note">
        <Flash state={state} />
        {usedBy > 0 ? (
          <>
            <strong>{usedBy} issue{usedBy === 1 ? " was" : "s were"} composed from this template,</strong> so it can
            only be switched off: untick Offered when composing.
          </>
        ) : (
          <>
            <strong>Delete this template.</strong> No issue was composed from it. The audit trail keeps a copy of the
            layout.
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="ghost small" type="submit" disabled={pending}>
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </form>
  );
}
