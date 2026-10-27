"use client";

/** The forms on the quantities screens: open a month, fill its sheet, and manage the countries. */

import { useActionState, useState } from "react";

import {
  clearSheetAction,
  openMonthAction,
  saveSheetAction,
  saveTradePlaceAction,
  type QtyResult,
} from "./actions";

function Flash({ state }: { state: QtyResult }) {
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

/** Pick a reporting country and a month, and go to its sheet. */
export function OpenMonth({
  slug,
  kind,
  places,
  location,
  month,
}: {
  slug: string;
  kind: string;
  places: { id: number; title: string }[];
  /** Fixed when the screen is already one country's. */
  location?: number;
  month: string;
}) {
  const [state, action, pending] = useActionState(openMonthAction, null as QtyResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="kind" value={kind} />
      <Flash state={state} />
      <div className="bar">
        {location ? (
          <input type="hidden" name="location" value={location} />
        ) : (
          <div className="field grow">
            <label htmlFor="open-location">Reporting country</label>
            <select id="open-location" name="location" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="open-month">Month</label>
          <input id="open-month" name="month" type="month" required defaultValue={month} />
        </div>
        <button type="submit" disabled={pending}>
          Open the month
        </button>
      </div>
    </form>
  );
}

/** One month's figures, a box per partner country. */
export function SheetForm({
  slug,
  kind,
  location,
  date,
  rows,
}: {
  slug: string;
  kind: string;
  location: number;
  date: string;
  rows: { id: number; title: string; qty: string | null }[];
}) {
  const [state, action, pending] = useActionState(saveSheetAction, null as QtyResult);
  const [cleared, clear, clearing] = useActionState(clearSheetAction, null as QtyResult);
  const [filter, setFilter] = useState("");
  const [onlyFilled, setOnlyFilled] = useState(false);
  const shown = (row: { title: string; qty: string | null }) =>
    row.title.toLowerCase().includes(filter.trim().toLowerCase()) && (!onlyFilled || row.qty !== null);
  const filled = rows.filter((row) => row.qty !== null).length;

  return (
    <>
      <form action={action}>
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="location" value={location} />
        <input type="hidden" name="date" value={date} />

        <Flash state={state} />

        <div className="bar" style={{ marginBottom: 12 }}>
          <div className="field grow">
            <label htmlFor="filter">Find a country</label>
            <input id="filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Type to narrow the list" />
          </div>
          <label className="check" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={onlyFilled} onChange={(event) => setOnlyFilled(event.target.checked)} />
            Only the {filled} with figures
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save the month"}
          </button>
        </div>

        <table className="inputs">
          <thead>
            <tr>
              <th>{kind === "export" ? "To" : "From"}</th>
              <th className="num" style={{ width: 200 }}>
                Quantity
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              // Hidden rather than left out, so a filtered-away box is still saved as it was.
              <tr key={row.id} style={shown(row) ? undefined : { display: "none" }}>
                <td>{row.title}</td>
                <td>
                  <input
                    name={`qty_${row.id}`}
                    type="text"
                    inputMode="decimal"
                    aria-label={`Quantity, ${row.title}`}
                    aria-invalid={state?.field === "quantities" || undefined}
                    defaultValue={row.qty === null ? "" : String(Number(row.qty))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="actions" style={{ marginTop: 12 }}>
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save the month"}
          </button>
          <span className="small muted">An empty box means no figure. Emptying a box removes its figure.</span>
        </div>
      </form>

      {filled > 0 ? (
        <form action={clear} style={{ marginTop: 16 }}>
          <input type="hidden" name="site" value={slug} />
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="location" value={location} />
          <input type="hidden" name="date" value={date} />
          <div className="note">
            <Flash state={cleared} />
            <strong>Clear this month.</strong> Removes all {filled} figures on this sheet. The audit trail records it.
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="ghost small" type="submit" disabled={clearing}>
                Clear the month
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </>
  );
}

export function NewPlace({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(saveTradePlaceAction, null as QtyResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="visible" value="on" />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="new-place">Country</label>
          <input id="new-place" name="title" type="text" required maxLength={191} aria-invalid={state?.field === "title" || undefined} />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add country"}
        </button>
      </div>
      {state?.error ? <div className="small bad">{state.error}</div> : state?.saved ? <div className="small muted">{state.saved}</div> : null}
    </form>
  );
}

export function PlaceRow({ slug, row }: { slug: string; row: { id: number; title: string; visible: boolean } }) {
  const [state, action, pending] = useActionState(saveTradePlaceAction, null as QtyResult);
  const form = `place-${row.id}`;

  return (
    <tr>
      <td>
        <form id={form} action={action}>
          <input type="hidden" name="site" value={slug} />
          <input type="hidden" name="id" value={row.id} />
        </form>
        <input form={form} name="title" type="text" required maxLength={191} defaultValue={row.title} aria-label="Country" />
        {state?.error ? <div className="small bad">{state.error}</div> : state?.saved ? <div className="small muted">{state.saved}</div> : null}
      </td>
      <td>
        <label className="check">
          <input form={form} type="checkbox" name="visible" defaultChecked={row.visible} />
          Shown on the site
        </label>
      </td>
      <td>
        <button form={form} type="submit" className="small" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
      </td>
    </tr>
  );
}
