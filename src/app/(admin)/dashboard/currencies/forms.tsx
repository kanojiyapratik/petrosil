"use client";

/** Currencies, edited in place in the list by a superadmin. */

import { useActionState } from "react";

import { saveCurrencyAction, type CurrencyResult } from "./actions";

function Note({ state }: { state: CurrencyResult }) {
  if (state?.error) {
    return (
      <div className="small bad" role="alert">
        {state.error}
      </div>
    );
  }

  return state?.saved ? (
    <div className="small muted" role="status">
      {state.saved}
    </div>
  ) : null;
}

export function NewCurrency() {
  const [state, action, pending] = useActionState(saveCurrencyAction, null as CurrencyResult);

  return (
    <form action={action}>
      <input type="hidden" name="enabled" value="on" />
      <div className="bar">
        <div className="field" style={{ minWidth: 0, width: 100 }}>
          <label htmlFor="new-code">Code</label>
          <input id="new-code" name="code" type="text" required maxLength={3} placeholder="AED" style={{ textTransform: "uppercase" }} />
        </div>
        <div className="field grow">
          <label htmlFor="new-title">Name</label>
          <input id="new-title" name="title" type="text" required maxLength={96} placeholder="UAE Dirham" />
        </div>
        <div className="field" style={{ minWidth: 0, width: 100 }}>
          <label htmlFor="new-symbol">Symbol</label>
          <input id="new-symbol" name="symbol" type="text" required maxLength={8} />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add currency"}
        </button>
      </div>
      <Note state={state} />
    </form>
  );
}

export function CurrencyRow({
  row,
}: {
  row: { id: number; code: string; title: string; symbol: string; enabled: boolean; locations: number };
}) {
  const [state, action, pending] = useActionState(saveCurrencyAction, null as CurrencyResult);
  const form = `currency-${row.id}`;

  return (
    <tr>
      <td style={{ width: 90 }}>
        <form id={form} action={action}>
          <input type="hidden" name="id" value={row.id} />
        </form>
        <input form={form} name="code" type="text" required maxLength={3} defaultValue={row.code} aria-label="Code" />
      </td>
      <td>
        <input form={form} name="title" type="text" required maxLength={96} defaultValue={row.title} aria-label="Name" />
        <Note state={state} />
      </td>
      <td style={{ width: 90 }}>
        <input form={form} name="symbol" type="text" required maxLength={8} defaultValue={row.symbol} aria-label="Symbol" />
      </td>
      <td>
        <label className="check">
          <input form={form} type="checkbox" name="enabled" defaultChecked={row.enabled} />
          Offered
        </label>
      </td>
      <td className="num">{row.locations === 0 ? <span className="muted">unused</span> : row.locations.toLocaleString("en-IN")}</td>
      <td>
        <button form={form} type="submit" className="small" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </td>
    </tr>
  );
}
