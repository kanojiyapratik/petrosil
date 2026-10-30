"use client";

/**
 * One form shape for every reader form on a brand site: the brand rides as a
 * hidden field, the action's message shows above the fields, and the field
 * the action complained about is marked. A form whose job is finished (a
 * link was sent, a password was set) swaps its fields for the message, so
 * nobody sends it twice.
 */

import { useActionState } from "react";

import type { FormState } from "./actions";

type Action = (state: FormState, form: FormData) => Promise<FormState>;

export function ReaderForm({
  action,
  site,
  submit,
  busy,
  hidden = {},
  keepOpen = false,
  after,
  children,
}: {
  action: Action;
  site: string;
  submit: string;
  busy: string;
  hidden?: Record<string, string>;
  /** Leave the fields up after success — for forms people use again, like their details. */
  keepOpen?: boolean;
  /** Shown under the message once the form is done. */
  after?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [state, run, pending] = useActionState(action, null);

  if (state?.done && !keepOpen) {
    return (
      <div className="bs-form">
        <p className="bs-flash good" role="status">
          {state.done}
        </p>
        {after}
      </div>
    );
  }

  return (
    <form action={run} className="bs-form" data-bad={state?.field}>
      {state?.error ? (
        <p className="bs-flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.done ? (
        <p className="bs-flash good" role="status">
          {state.done}
        </p>
      ) : null}

      <input type="hidden" name="site" value={site} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {children}

      <button className="btn" type="submit" disabled={pending}>
        {pending ? busy : submit}
      </button>
    </form>
  );
}

export function Field({
  name,
  label,
  hint,
  wide,
  ...input
}: { name: string; label: string; hint?: string; wide?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="bs-field" data-name={name} data-wide={wide || undefined}>
      <span>{label}</span>
      <input name={name} {...input} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** The country list as a plain select: free text is refused, since the currency is decided by it. */
export function CountryField({
  countries,
  value,
  required,
  hint,
}: {
  countries: string[];
  value?: string | null;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="bs-field" data-name="country">
      <span>Country</span>
      <select name="country" defaultValue={value ?? ""} required={required}>
        <option value="">Choose…</option>
        {countries.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
