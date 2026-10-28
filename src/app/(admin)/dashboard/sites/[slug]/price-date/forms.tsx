"use client";

/** The forms on one date's screen: withdraw ticked prices, and put a withdrawal back. */

import Link from "next/link";
import { useActionState, useState } from "react";

import type { DatePrice } from "@/domain/price/date-corrections";
import { putBackAction, withdrawAction, type CorrectionState } from "./actions";

const figure = (value: string) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 4 });

function Flash({ state }: { state: CorrectionState }) {
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

export function WithdrawForm({ slug, date, rows }: { slug: string; date: string; rows: DatePrice[] }) {
  const [state, action, pending] = useActionState(withdrawAction, null as CorrectionState);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const all = ticked.size === rows.length && rows.length > 0;
  const shown = (row: DatePrice) => row.title.toLowerCase().includes(filter.trim().toLowerCase());

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
    <form
      action={action}
      onSubmit={(event) => {
        const message = all
          ? `Withdraw every price on ${date} — all ${rows.length}? They come off the site at once.`
          : `Withdraw ${ticked.size} price${ticked.size === 1 ? "" : "s"} on ${date}? They come off the site at once.`;

        if (!window.confirm(message)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="date" value={date} />

      <Flash state={state} />

      <div className="bar" style={{ marginBottom: 12 }}>
        <div className="field grow">
          <label htmlFor="filter">Find a market</label>
          <input id="filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Type to narrow the list" />
        </div>
        <button type="submit" className="danger" disabled={pending || ticked.size === 0}>
          {pending ? "Withdrawing…" : all ? "Withdraw the whole date" : `Withdraw ${ticked.size || ""} ticked`}
        </button>
      </div>

      <table className="tight">
        <thead>
          <tr>
            <th style={{ width: 32 }}>
              <input
                type="checkbox"
                aria-label="Tick every price on this date"
                checked={all}
                onChange={() => setTicked(all ? new Set() : new Set(rows.map((row) => row.id)))}
              />
            </th>
            <th>Market</th>
            <th className="num">Price</th>
            <th>Set by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            // Hidden rather than left out, so a ticked row filtered away is still sent.
            <tr key={row.id} style={shown(row) ? undefined : { display: "none" }}>
              <td>
                <input
                  type="checkbox"
                  name="price"
                  value={row.id}
                  aria-label={`Withdraw ${row.title}`}
                  checked={ticked.has(row.id)}
                  onChange={() => toggle(row.id)}
                />
              </td>
              <td>
                {row.title}
                {row.visible ? null : <span className="tag" style={{ marginLeft: 8 }}>held</span>}
              </td>
              <td className="num">
                {figure(row.price)} <span className="small muted">{row.currency}</span>
              </td>
              <td className="small">
                {row.setBy ? (
                  <Link href={`/dashboard/sites/${slug}/batches/${row.setBy.batchId}`}>
                    #{row.setBy.batchId} · {row.setBy.source.replace("_", " ")}
                  </Link>
                ) : (
                  <span className="muted">carried from the old site</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </form>
  );
}

export function PutBack({ slug, withdrawal }: { slug: string; withdrawal: number }) {
  const [state, action, pending] = useActionState(putBackAction, null as CorrectionState);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="withdrawal" value={withdrawal} />
      <button type="submit" className="ghost small" disabled={pending || Boolean(state?.done)}>
        {pending ? "Putting back…" : "Put back"}
      </button>
      {state?.error ? <div className="small bad">{state.error}</div> : state?.done ? <div className="small muted">{state.done}</div> : null}
    </form>
  );
}
