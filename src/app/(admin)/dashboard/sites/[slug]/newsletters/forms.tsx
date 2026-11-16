"use client";

/**
 * The newsletter forms that answer back: starting an issue from a template,
 * editing a draft, and a test send.
 */

import { startTransition, useActionState, useState } from "react";

import { Popup } from "@/app/(admin)/popup";
import {
  addOptOutAction,
  composeAction,
  removeOptOutAction,
  saveAction,
  sendAction,
  testSendAction,
  type IssueResult,
} from "./actions";

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

const CHOICES = [
  { value: "everyone", label: "Every subscriber" },
  { value: "paying", label: "Paying readers only" },
  { value: "free", label: "Free and trial readers only" },
] as const;

/**
 * Sending to subscribers, in a popup: who it goes to, then the number typed
 * back as the confirmation. The server re-counts and refuses a number that no
 * longer matches.
 */
export function SendForm({
  id,
  site,
  counts,
}: {
  id: number;
  site: string;
  counts: { everyone: number; paying: number; free: number; optedOut: number };
}) {
  const [state, action, pending] = useActionState(sendAction, null as IssueResult);
  const [audience, setAudience] = useState<(typeof CHOICES)[number]["value"]>("everyone");
  const reach = counts[audience];

  // Submitted by hand, not through `action=`: React resets a form after its
  // action, which put the radio back on "Every subscriber" while the count
  // beside the box still said the paying number. The next press would have
  // gone to the wrong list.
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(() => action(data));
  };

  return (
    <Popup label="Send to subscribers" title="Send this issue to subscribers">
      <form onSubmit={submit}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="site" value={site} />
        <Flash state={state} />

        <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 .8rem" }}>
          <legend>Who it goes to</legend>
          {CHOICES.map((choice) => (
            <label key={choice.value} style={{ display: "block", margin: ".25rem 0" }}>
              <input
                type="radio"
                name="audience"
                value={choice.value}
                checked={audience === choice.value}
                onChange={() => setAudience(choice.value)}
              />{" "}
              {choice.label} — <strong>{counts[choice.value].toLocaleString("en-GB")}</strong>
            </label>
          ))}
        </fieldset>

        <p className="small muted">
          Active accounts on this brand only. {counts.optedOut.toLocaleString("en-GB")} address
          {counts.optedOut === 1 ? " has" : "es have"} unsubscribed and {counts.optedOut === 1 ? "is" : "are"} left out.
          Every copy has its own unsubscribe link. Once sent, the issue can no longer be edited.
        </p>

        <div className="field">
          <label htmlFor="send-confirm">
            Type <strong>{reach.toLocaleString("en-GB")}</strong> to send it to that many people
          </label>
          <input id="send-confirm" name="confirm" type="text" inputMode="numeric" autoComplete="off" required />
        </div>

        <div className="actions">
          <button type="submit" disabled={pending || reach === 0}>
            {pending ? "Queuing…" : `Send to ${reach.toLocaleString("en-GB")}`}
          </button>
        </div>
      </form>
    </Popup>
  );
}

/** Taking one address off the brand's newsletter by hand. */
export function AddOptOutForm({ site }: { site: string }) {
  const [state, action, pending] = useActionState(addOptOutAction, null as IssueResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={site} />
      <Flash state={state} />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="optout-email">Email address</label>
          <input id="optout-email" name="email" type="email" maxLength={191} required placeholder="name@company.com" />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Take off the newsletter"}
        </button>
      </div>
      <p className="small muted" style={{ margin: ".4rem 0 0" }}>
        For someone who asked by email or phone. They keep their account and their reports; only the newsletter stops.
      </p>
    </form>
  );
}

/** Putting one address back: asks first, since they may have asked for no mail. */
export function PutBackForm({ site, id, email, source }: { site: string; id: number; email: string; source: string }) {
  return (
    <form
      action={removeOptOutAction}
      onSubmit={(event) => {
        const warning =
          source === "link"
            ? `${email} unsubscribed themselves. Only put them back if they have asked you to. Put back on the newsletter?`
            : `Put ${email} back on the newsletter?`;

        if (!window.confirm(warning)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="site" value={site} />
      <input type="hidden" name="id" value={id} />
      <button className="ghost small" type="submit">
        Put back
      </button>
    </form>
  );
}
