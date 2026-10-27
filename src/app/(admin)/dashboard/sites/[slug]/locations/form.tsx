"use client";

/**
 * A price location's name, currency and unit.
 *
 * The name is how the price module, the crawler and the upload sheets find
 * the location, so renaming one says so: prices sent under the old name come
 * back unmatched until the sender uses the new one.
 */

import { useActionState } from "react";

import type { LocationForEdit } from "@/domain/dashboard/locations";
import { saveLocationAction, type LocationResult } from "./actions";

export function LocationForm({
  slug,
  currencies,
  location,
}: {
  slug: string;
  currencies: { code: string; title: string }[];
  location?: LocationForEdit;
}) {
  const [state, action, pending] = useActionState(saveLocationAction, null as LocationResult);
  const bad = (field: string) => state?.field === field || undefined;

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {location ? <input type="hidden" name="id" value={location.id} /> : null}

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <p className="flash" role="status">
          {state.saved}
        </p>
      ) : null}

      <div className="bar">
        <div className="field grow">
          <label htmlFor="loc-title">Name</label>
          <input
            id="loc-title"
            name="title"
            type="text"
            required
            maxLength={191}
            defaultValue={location?.title ?? ""}
            placeholder="Singapore SN 150 FOB"
            aria-invalid={bad("title")}
          />
        </div>
        <div className="field">
          <label htmlFor="loc-currency">Currency</label>
          <select id="loc-currency" name="currency" defaultValue={location?.currency ?? currencies[0]?.code ?? ""} aria-invalid={bad("currency")}>
            {currencies.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code} — {currency.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 0, width: 110 }}>
          <label htmlFor="loc-unit">Unit</label>
          <input id="loc-unit" name="unit" type="text" maxLength={32} defaultValue={location?.unit ?? ""} placeholder="MT" />
        </div>
        <div className="field" style={{ minWidth: 0, width: 100 }}>
          <label htmlFor="loc-order">Position</label>
          <input id="loc-order" name="sort_order" type="number" step={1} defaultValue={location?.sort_order ?? 0} />
        </div>
        <label className="check" style={{ marginBottom: 8 }}>
          <input type="checkbox" name="visible" defaultChecked={location?.visible ?? true} />
          Published
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : location ? "Save" : "Add location"}
        </button>
      </div>

      <p className="small muted" style={{ margin: "8px 0 0" }}>
        {location
          ? "The price module, the crawler and upload sheets find a location by this name. After a rename, prices sent under the old name come back unmatched until the sender uses the new one."
          : "Use the exact name the price module and the upload sheets will send. Case and spacing are ignored when matching."}
      </p>
    </form>
  );
}
