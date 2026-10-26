"use client";

/**
 * One template: subject, HTML body, on/off, and a preview.
 *
 * The body is the HTML the old sites stored, edited as HTML; the old TinyMCE
 * editor is not carried. The preview renders it in a sandboxed frame, so a
 * template cannot run script in the admin.
 */

import { useActionState } from "react";

import { saveTemplate, type TemplateResult } from "./actions";

export type TemplateView = {
  id: number;
  subject: string;
  body: string;
  enabled: boolean;
  fields: string[];
};

export function TemplateForm({ template }: { template: TemplateView }) {
  const [state, action, pending] = useActionState(saveTemplate, null as TemplateResult);
  const id = template.id;

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />

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
      {state?.warning ? (
        <p className="flash bad" role="alert">
          {state.warning}
        </p>
      ) : null}

      <div className="bar">
        <div className="field grow">
          <label htmlFor={`subject-${id}`}>Subject</label>
          <input
            id={`subject-${id}`}
            name="subject"
            type="text"
            maxLength={255}
            defaultValue={template.subject}
            required
          />
        </div>
        <div className="field">
          <label>
            <input type="checkbox" name="enabled" defaultChecked={template.enabled} /> On
          </label>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="field" style={{ marginTop: ".5rem" }}>
        <label htmlFor={`body-${id}`}>Body (HTML)</label>
        <textarea
          id={`body-${id}`}
          name="body"
          rows={10}
          defaultValue={template.body}
          spellCheck={false}
          style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          required
        />
      </div>

      {template.fields.length > 0 ? (
        <p className="small muted" style={{ margin: ".4rem 0 0" }}>
          Filled when sent: {template.fields.map((name) => `{${name}}`).join(" ")}
        </p>
      ) : null}

      <details style={{ marginTop: ".5rem" }}>
        <summary className="small">Preview as saved</summary>
        <iframe
          title={`Preview of template ${id}`}
          sandbox=""
          srcDoc={template.body}
          style={{ width: "100%", height: 420, border: "1px solid var(--line, #ddd)", background: "#fff" }}
        />
      </details>
    </form>
  );
}
