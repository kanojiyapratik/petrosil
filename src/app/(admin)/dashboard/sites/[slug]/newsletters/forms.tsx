"use client";

/**
 * The newsletter forms that answer back: starting an issue from a template,
 * editing a draft, and a test send.
 */

import { useActionState } from "react";

import { composeAction, saveAction, testSendAction, type IssueResult } from "./actions";

function Flash({ state }: { state: IssueResult }) {
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

export function ComposeForm({ site, templates }: { site: string; templates: { id: number; title: string }[] }) {
  const [state, action, pending] = useActionState(composeAction, null as IssueResult);

  if (templates.length === 0) {
    return <p className="muted">This brand has no newsletter template switched on, so there is nothing to start from.</p>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="site" value={site} />
      <Flash state={state} />
      <div className="bar">
        <div className="field">
          <label htmlFor="template">Template</label>
          <select id="template" name="template" defaultValue={templates[0]!.id}>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="title">Title (optional)</label>
          <input id="title" name="title" type="text" maxLength={255} placeholder="Defaults to the brand and today's date" />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Building…" : "Start a new issue"}
        </button>
      </div>
      <p className="small muted" style={{ margin: ".4rem 0 0" }}>
        Fills the template with the brand&apos;s latest 10 articles, 5 reports, 10 offers and 10 trade sheets,
        as the old composer did. Saved as a draft for you to edit.
      </p>
    </form>
  );
}

export function EditIssueForm({ id, title, body }: { id: number; title: string; body: string }) {
  const [state, action, pending] = useActionState(saveAction, null as IssueResult);

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Flash state={state} />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="issue-title">Title (the mail&apos;s subject)</label>
          <input id="issue-title" name="title" type="text" maxLength={255} defaultValue={title} required />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="field" style={{ marginTop: ".5rem" }}>
        <label htmlFor="issue-body">Body (HTML)</label>
        <textarea
          id="issue-body"
          name="body"
          rows={18}
          defaultValue={body}
          spellCheck={false}
          style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          required
        />
      </div>
    </form>
  );
}

export function TestSendForm({ id }: { id: number }) {
  const [state, action, pending] = useActionState(testSendAction, null as IssueResult);

  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={id} />
      <button className="ghost" type="submit" disabled={pending}>
        {pending ? "Queuing…" : "Send a test to me"}
      </button>
      <Flash state={state} />
    </form>
  );
}
