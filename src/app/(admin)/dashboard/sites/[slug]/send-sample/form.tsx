"use client";

/** Pick the reports for a sample; the reader was chosen on the page. */

import { useActionState } from "react";

import { sendSampleAction, type SendResult } from "../reports/[id]/send/actions";

export function SendSampleForm(props: {
  site: string;
  userId: number;
  reports: { id: number; title: string; file: string }[];
  /** Staff's own emails, offered instead of the sample-reports mail. */
  emails: { key: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(sendSampleAction, null as SendResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={props.site} />
      <input type="hidden" name="user" value={props.userId} />

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}

      <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--line, #ddd)", padding: ".5rem" }}>
        {props.reports.map((report, index) => (
          <label key={report.id} style={{ display: "block", padding: "2px 0" }}>
            {/* The old screen always sent the two latest; that is still the default. */}
            <input type="checkbox" name="report" value={report.id} defaultChecked={index < 2} /> {report.title}{" "}
            <span className="muted small">{report.file}</span>
          </label>
        ))}
      </div>

      {props.emails.length > 0 ? (
        <div className="field" style={{ marginTop: ".75rem" }}>
          <label htmlFor="sample-email">Email</label>
          <select id="sample-email" name="email" defaultValue="">
            <option value="">The sample-reports mail (Asia edition for South Asia)</option>
            {props.emails.map((email) => (
              <option key={email.key} value={email.key}>
                {email.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="bar" style={{ marginTop: ".75rem" }}>
        <button type="submit" disabled={pending}>
          {pending ? "Queuing…" : "Send the sample"}
        </button>
        <span className="small muted">
          {props.emails.length > 0
            ? "Emails you add on System emails can be picked above."
            : "Uses the brand’s sample-reports mail: the Asia edition for South Asia, the other for everyone else."}
        </span>
      </div>
    </form>
  );
}
