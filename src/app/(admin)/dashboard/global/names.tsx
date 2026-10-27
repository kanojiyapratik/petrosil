"use client";

/**
 * A list of names across the brands: ad slots, or article categories.
 *
 * Each row shows which brands have the name. Opening it gives a new name,
 * the brands to act on (those that have it, to start with), and Apply or
 * Remove. Apply adds the name to a ticked brand that lacks it.
 */

import { useActionState, useState } from "react";

import { categoryAction, slotAction, type GlobalResult } from "./actions";

type Brand = { slug: string; name: string };
type Holder = Brand & { enabled?: boolean; count: number };
type Row = { title: string; brands: Holder[] };

type Kind = "slot" | "category";

const ACTION = { slot: slotAction, category: categoryAction } as const;
const WORDS = {
  slot: { noun: "slot", count: "ads", offered: "Offered" },
  category: { noun: "category", count: "articles", offered: null },
} as const;

function Note({ state }: { state: GlobalResult }) {
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

function Ticks({ brands, chosen, onChange }: { brands: Brand[]; chosen: string[]; onChange: (next: string[]) => void }) {
  const all = brands.length > 0 && brands.every((brand) => chosen.includes(brand.slug));

  return (
    <div className="checks">
      {brands.length > 1 ? (
        <label className="check all">
          <input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked ? brands.map((b) => b.slug) : [])} />
          All brands
        </label>
      ) : null}
      {brands.map((brand) => (
        <label className="check" key={brand.slug}>
          <input
            type="checkbox"
            name="site"
            value={brand.slug}
            checked={chosen.includes(brand.slug)}
            onChange={(event) =>
              onChange(event.target.checked ? [...new Set([...chosen, brand.slug])] : chosen.filter((slug) => slug !== brand.slug))
            }
          />
          {brand.name}
        </label>
      ))}
    </div>
  );
}

/** Add a new name to the brands ticked. */
export function AddName({ kind, brands }: { kind: Kind; brands: Brand[] }) {
  const [state, action, pending] = useActionState(ACTION[kind], null as GlobalResult);
  const [chosen, setChosen] = useState(brands.map((brand) => brand.slug));
  const words = WORDS[kind];

  return (
    <form action={action}>
      {words.offered ? <input type="hidden" name="enabled" value="on" /> : null}
      <Note state={state} />
      <div className="bar" style={{ marginBottom: 12 }}>
        <div className="field grow">
          <label htmlFor={`add-${kind}`}>New {words.noun}</label>
          <input id={`add-${kind}`} name="title" type="text" required maxLength={191} />
        </div>
        {kind === "category" ? (
          <div className="field" style={{ minWidth: 0, width: 110 }}>
            <label htmlFor="add-position">Position</label>
            <input id="add-position" name="sort_order" type="number" step={1} defaultValue={0} />
          </div>
        ) : null}
        <button type="submit" disabled={pending || chosen.length === 0}>
          {pending ? "Adding…" : `Add to ${chosen.length} brand${chosen.length === 1 ? "" : "s"}`}
        </button>
      </div>
      <Ticks brands={brands} chosen={chosen} onChange={setChosen} />
    </form>
  );
}

function NameRow({ kind, row, brands }: { kind: Kind; row: Row; brands: Brand[] }) {
  const [state, action, pending] = useActionState(ACTION[kind], null as GlobalResult);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(row.brands.map((brand) => brand.slug));
  const words = WORDS[kind];
  const has = new Map(row.brands.map((brand) => [brand.slug, brand]));
  const offered = row.brands.filter((brand) => brand.enabled !== false).length;

  return (
    <>
      <tr>
        <td>
          <strong>{row.title}</strong>
          {state && !open ? <Note state={state} /> : null}
        </td>
        <td>
          {brands.map((brand) => {
            const holder = has.get(brand.slug);

            return (
              <span
                key={brand.slug}
                className={`tag${holder ? "" : " muted"}`}
                style={{ marginRight: 4, opacity: holder ? 1 : 0.35 }}
                title={holder ? `${brand.name}: ${holder.count} ${words.count}` : `${brand.name}: not there`}
              >
                {brand.name}
                {holder && holder.enabled === false ? " (off)" : ""}
              </span>
            );
          })}
        </td>
        <td className="num">
          {row.brands.length} of {brands.length}
          {words.offered && offered < row.brands.length ? <div className="small muted">{offered} offered</div> : null}
        </td>
        <td>
          <button type="button" className="ghost small" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Change"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={4} style={{ background: "var(--panel-alt, transparent)" }}>
            <form action={action}>
              <input type="hidden" name="title" value={row.title} />
              <Note state={state} />
              <div className="bar" style={{ marginBottom: 12 }}>
                <div className="field grow">
                  <label htmlFor={`rename-${kind}-${row.title}`}>Name on the brands ticked</label>
                  <input id={`rename-${kind}-${row.title}`} name="new_title" type="text" maxLength={191} defaultValue={row.title} />
                </div>
                {kind === "category" ? (
                  <div className="field" style={{ minWidth: 0, width: 110 }}>
                    <label htmlFor={`position-${row.title}`}>Position</label>
                    <input id={`position-${row.title}`} name="sort_order" type="number" step={1} placeholder="keep" />
                  </div>
                ) : null}
                {words.offered ? (
                  <label className="check" style={{ marginBottom: 8 }}>
                    <input type="checkbox" name="enabled" defaultChecked={offered > 0} />
                    {words.offered}
                  </label>
                ) : null}
                <button type="submit" name="intent" value="apply" disabled={pending || chosen.length === 0}>
                  {pending ? "Working…" : "Apply"}
                </button>
                <button type="submit" name="intent" value="remove" className="ghost" disabled={pending || chosen.length === 0}>
                  Remove
                </button>
              </div>
              <Ticks brands={brands} chosen={chosen} onChange={setChosen} />
              <p className="small muted" style={{ margin: "10px 0 0" }}>
                Apply renames it where a ticked brand has it and adds it where one does not. Remove takes it off the ticked
                brands, except where {words.count} are still in it.
              </p>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function NameTable({ kind, rows, brands }: { kind: Kind; rows: Row[]; brands: Brand[] }) {
  return (
    <table className="tight">
      <thead>
        <tr>
          <th>Name</th>
          <th>Brands</th>
          <th className="num">How many</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <NameRow key={row.title.toLowerCase()} kind={kind} row={row} brands={brands} />
        ))}
      </tbody>
    </table>
  );
}
