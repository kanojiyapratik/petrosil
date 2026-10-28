"use client";

/** The price-entry grid: a box per market for one date. */

import Link from "next/link";
import { useActionState, useState } from "react";

import type { EntryRow } from "@/domain/price/entry";
import { enterPricesAction, type EntryState } from "./actions";

const figure = (value: string) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 4 });

function Outcome({ slug, state }: { slug: string; state: EntryState }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  const result = state?.result;

  if (!result) {
    return null;
  }

  const written = result.created + result.changed;

  return (
    <div role="status">
      <p className={result.locked.length || result.conflicts ? "flash bad" : "flash"}>
        {written === 0 ? (
          "Nothing changed: every figure was empty or already published."
        ) : (
          <>
            Published {result.created ? `${result.created} new` : ""}
            {result.created && result.changed ? " and " : ""}
            {result.changed ? `${result.changed} changed` : ""} price{written === 1 ? "" : "s"}.{" "}
            <Link href={`/dashboard/sites/${slug}/batches/${result.batchId}`}>See the update</Link>
          </>
        )}
        {result.conflicts
          ? ` ${result.conflicts} moved while you were typing and were left alone; reload to see them.`
          : ""}
      </p>
      {result.locked.length ? (
        <div className="note" style={{ marginBottom: 12 }}>
          <strong>Left alone, because a published price on a past date is history:</strong>
          <ul className="small">
            {result.locked.map((row) => (
              <li key={row.title}>
                {row.title}: published {figure(row.published)}, you entered {figure(row.entered)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function EntryForm({
  slug,
  date,
  past,
  rows,
}: {
  slug: string;
  date: string;
  past: boolean;
  rows: EntryRow[];
}) {
  const [state, action, pending] = useActionState(enterPricesAction, null as EntryState);
  const [filter, setFilter] = useState("");
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const empty = rows.filter((row) => row.onDate === null).length;
  const shown = (row: EntryRow) =>
    row.title.toLowerCase().includes(filter.trim().toLowerCase()) && (!onlyEmpty || row.onDate === null);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="date" value={date} />

      <Outcome slug={slug} state={state} />

      <div className="bar" style={{ marginBottom: 12 }}>
        <div className="field grow">
          <label htmlFor="filter">Find a market</label>
          <input
            id="filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Type to narrow the list"
          />
        </div>
        <label className="check" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={onlyEmpty} onChange={(event) => setOnlyEmpty(event.target.checked)} />
          Only the {empty} without a price
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Publishing…" : "Publish the prices"}
        </button>
      </div>

      <table className="inputs">
        <thead>
          <tr>
            <th>Market</th>
            <th className="num">Price before</th>
            <th className="num" style={{ width: 200 }}>
              Price on this date
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // A published past figure is history: shown, not offered for editing.
            const fixed = past && row.onDate !== null;

            return (
              // Hidden rather than left out, so a filtered-away box still saves as typed.
              <tr key={row.id} style={shown(row) ? undefined : { display: "none" }}>
                <td>
                  {row.title}
                  {row.visible ? null : <span className="tag" style={{ marginLeft: 8 }}>held</span>}
                  <div className="small muted">{[row.currency, row.unit].filter(Boolean).join(" / ")}</div>
                </td>
                <td className="num">
                  {row.before ? (
                    <>
                      {figure(row.before.price)}
                      <div className="small muted">{row.before.date}</div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {fixed ? (
                    <span title="A published price on a past date cannot be changed here">
                      {figure(row.onDate!)} <span className="small muted">published</span>
                    </span>
                  ) : (
                    <input
                      name={`price_${row.id}`}
                      type="text"
                      inputMode="decimal"
                      aria-label={`Price, ${row.title}`}
                      aria-invalid={state?.field === "prices" || undefined}
                      defaultValue={row.onDate === null ? "" : String(Number(row.onDate))}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="actions" style={{ marginTop: 12 }}>
        <button type="submit" disabled={pending}>
          {pending ? "Publishing…" : "Publish the prices"}
        </button>
        <span className="small muted">
          An empty box leaves that market as it is. Saved figures publish at once, as one price update you can roll back.
        </span>
      </div>
    </form>
  );
}
