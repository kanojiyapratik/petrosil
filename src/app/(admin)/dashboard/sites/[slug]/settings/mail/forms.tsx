"use client";

/** The forms on the Mail screen. */

import { useActionState } from "react";

import { deleteOldAction, saveSenderAction, sendTestAction, type MailState } from "./actions";

function Flash({ state }: { state: MailState }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  return state?.done ? (
    <p className="flash" role="status">
      {state.done}
    </p>
  ) : null;
}

export function SenderForm({
  slug,
  fromAddress,
  replyTo,
  canEdit,
}: {
  slug: string;
  fromAddress: string | null;
  replyTo: string | null;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(saveSenderAction, null as MailState);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Flash state={state} />
      <div className="field">
        <label htmlFor="fromAddress">From address</label>
        <input
          id="fromAddress"
          name="fromAddress"
          type="email"
          defaultValue={fromAddress ?? ""}
          disabled={!canEdit}
          aria-invalid={state?.field === "fromAddress" || undefined}
          placeholder="Empty: the estate's address"
        />
        <div className="small muted">Must be a sender verified in Brevo. A new address is used once a test from it goes through.</div>
      </div>
      <div className="field">
        <label htmlFor="replyTo">Reply-to address</label>
        <input
          id="replyTo"
          name="replyTo"
          type="email"
          defaultValue={replyTo ?? ""}
          disabled={!canEdit}
          aria-invalid={state?.field === "replyTo" || undefined}
          placeholder="Empty: replies go to the From address"
        />
        <div className="small muted">A forwarded enquiry still replies to the member who wrote it.</div>
      </div>
      {canEdit ? (
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save the sender"}
        </button>
      ) : null}
    </form>
  );
}

export function TestForm({ slug, from, to }: { slug: string; from: string; to: string }) {
  const [state, action, pending] = useActionState(sendTestAction, null as MailState);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Flash state={state} />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="test-to">Send a test to</label>
          <input id="test-to" name="to" type="email" required defaultValue={to} aria-invalid={state?.field === "to" || undefined} />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : `Send a test from ${from}`}
        </button>
      </div>
    </form>
  );
}

export function DeleteOld({ slug, count }: { slug: string; count: number }) {
  const [state, action, pending] = useActionState(deleteOldAction, null as MailState);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`Delete the ${count} old mail settings for this brand? Nothing reads them; the audit trail records which were removed.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="site" value={slug} />
      <Flash state={state} />
      <button type="submit" className="danger small" disabled={pending || Boolean(state?.done)}>
        {pending ? "Deleting…" : "Delete the old credentials"}
      </button>
    </form>
  );
}
