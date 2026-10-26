"use client";

/**
 * The report send form: who gets it (every paying reader, ticked), extra
 * addresses, and the wording. `{name}`, `{email}` and `{site}` are filled for
 * each person when the mail is queued.
 */

import { useActionState, useState } from "react";

import { sendReportAction, type SendResult } from "./actions";

type Reader = { userId: number; name: string; email: string; company: string | null };

export function SendReportForm(props: {
  site: string;
  reportId: number;
  subject: string;
  body: string;
  readers: Reader[];
  extra: string[];
}) {
  const [state, action, pending] = useActionState(sendReportAction, null as SendResult);
  const [ticked, setTicked] = useState(() => new Set(props.readers.map((reader) => reader.userId)));
  const [extra, setExtra] = useState(props.extra.join("\n"));
  const extraCount = extra.split(/[\s,;]+/).filter((value) => value.includes("@")).length;

  const toggle = (id: number) =>
    setTicked((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });

  return (
    <form action={action}>
      <input type="hidden" name="site" value={props.site} />
      <input type="hidden" name="report" value={props.reportId} />

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="subject">Subject</label>
        <input id="subject" name="subject" type="text" maxLength={255} defaultValue={props.subject} required />
      </div>

      <div className="field" style={{ marginTop: ".5rem" }}>
        <label htmlFor="body">Message (HTML; {"{name}"}, {"{email}"} and {"{site}"} are filled for each person)</label>
        <textarea
          id="body"
          name="body"
          rows={8}
          defaultValue={props.body}
          spellCheck={false}
          style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          required
        />
      </div>

      <div className="heading" style={{ margin: "1rem 0 .4rem" }}>
        <strong>
          Paying readers: {ticked.size} of {props.readers.length} ticked
        </strong>
        <span className="spacer" />
        <button type="button" className="ghost small" onClick={() => setTicked(new Set(props.readers.map((r) => r.userId)))}>
          Tick all
        </button>
        <button type="button" className="ghost small" onClick={() => setTicked(new Set())}>
          Untick all
        </button>
      </div>

      <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--line, #ddd)", padding: ".5rem" }}>
        {props.readers.length === 0 ? <p className="muted">This brand has no current paying readers.</p> : null}
        {props.readers.map((reader) => (
          <label key={reader.userId} style={{ display: "block", padding: "2px 0" }}>
            <input
              type="checkbox"
              name="reader"
              value={reader.userId}
              checked={ticked.has(reader.userId)}
              onChange={() => toggle(reader.userId)}
            />{" "}
            {reader.name} <span className="muted small">{reader.email}{reader.company ? ` · ${reader.company}` : ""}</span>
          </label>
        ))}
      </div>

      <div className="field" style={{ marginTop: ".75rem" }}>
        <label htmlFor="extra">Also send to (staff and partners; one per line)</label>
        <textarea id="extra" name="extra" rows={3} value={extra} onChange={(event) => setExtra(event.target.value)} style={{ width: "100%" }} />
      </div>

      <div className="bar" style={{ marginTop: ".75rem" }}>
        <button type="submit" disabled={pending || ticked.size + extraCount === 0}>
          {pending ? "Queuing…" : `Send to ${ticked.size + extraCount}`}
        </button>
        <span className="small muted">Each mail is queued and goes with the next mail run; the delivery log shows each one.</span>
      </div>
    </form>
  );
}
