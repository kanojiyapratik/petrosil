"use client";

/** Pick the reports for a sample; the reader was chosen on the page. */

import { useActionState } from "react";

import { sendSampleAction, type SendResult } from "../reports/[id]/send/actions";

export function SendSampleForm(props: {
  site: string;
  userId: number;
  reports: { id: number; title: string; file: string }[];
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

      <div className="bar" style={{ marginTop: ".75rem" }}>
        <button type="submit" disabled={pending}>
          {pending ? "Queuing…" : "Send the sample"}
        </button>
        <span className="small muted">
          Uses the brand&apos;s sample-reports mail: the Asia edition for South Asia, the other for everyone else.
        </span>
      </div>
    </form>
  );
}
