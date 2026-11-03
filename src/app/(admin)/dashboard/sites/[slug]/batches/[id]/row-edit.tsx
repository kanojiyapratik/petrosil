"use client";

/**
 * Mending one row of a draft batch, in a popup: the old admin edited rows
 * inline on the batch screen. What may change follows `updateItem`: the
 * price and date only on a row that would publish or still needs a market;
 * the market only where none was settled (unmatched, ambiguous); whether the
 * row is in, always.
 */

import { useActionState } from "react";

import { Popup } from "@/app/(admin)/popup";
import { editRowAction, type RollBackState } from "./actions";

export type EditableRow = {
  id: number;
  location_id: number | null;
  raw_location: string;
  price_date: string;
  new_price: number;
  status: string;
  is_included: boolean;
};

const VALUE_EDITABLE = new Set(["changed", "new", "ambiguous", "unmatched"]);
const NEEDS_MARKET = new Set(["ambiguous", "unmatched"]);

export function RowEdit({
  slug,
  batch,
  row,
  markets,
}: {
  slug: string;
  batch: number;
  row: EditableRow;
  /** Passed only for a row that needs a market picked. */
  markets?: { id: number; title: string }[];
}) {
  const [state, action, pending] = useActionState(editRowAction, null as RollBackState);
  const valueEditable = VALUE_EDITABLE.has(row.status);

  return (
    <Popup label={NEEDS_MARKET.has(row.status) ? "Fix" : "Edit"} title={`Row: ${row.raw_location}`} ghost>
      <form action={action}>
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="batch" value={batch} />
        <input type="hidden" name="item" value={row.id} />
        <input type="hidden" name="was_location" value={row.location_id ?? ""} />

        {state?.error ? (
          <p className="flash bad" role="alert">
            {state.error}
          </p>
        ) : null}

        {markets ? (
          <div className="field">
            <label htmlFor={`market-${row.id}`}>Market</label>
            <select id={`market-${row.id}`} name="location_id" defaultValue={row.location_id ?? ""} required>
              <option value="" disabled>
                Pick the market “{row.raw_location}” means
              </option>
              {markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {valueEditable ? (
          <div className="cols">
            <div className="field">
              <label htmlFor={`price-${row.id}`}>Price</label>
              <input id={`price-${row.id}`} name="new_price" type="text" inputMode="decimal" defaultValue={row.new_price} required />
            </div>
            <div className="field">
              <label htmlFor={`date-${row.id}`}>Date</label>
              <input id={`date-${row.id}`} name="pricedate" type="date" defaultValue={row.price_date} required />
            </div>
          </div>
        ) : (
          <p className="small muted">
            A {row.status} row cannot have its price changed{row.status === "locked" ? ": a published past price is not overwritten" : ""}. It
            can be left out.
          </p>
        )}

        <div className="field">
          <label>
            <input type="checkbox" name="included" defaultChecked={row.is_included} /> Include this row when the batch is committed
          </label>
        </div>

        <div className="actions">
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save row"}
          </button>
        </div>
      </form>
    </Popup>
  );
}
