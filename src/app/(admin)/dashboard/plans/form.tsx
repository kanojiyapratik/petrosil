"use client";

/**
 * A plan: which brands sell it, which currencies it is priced in, a price for
 * each term in each currency, and a sale price for each while it is on sale.
 *
 * Ticking "All brands" ticks every brand; unticking one brand leaves it a
 * plan for the brands still ticked. A blank price means that term is not
 * offered in that currency. Prices here are what the checkout charges from
 * now on; every order already placed keeps its own.
 */

import { useActionState, useState } from "react";
import Link from "next/link";

import type { Brand } from "@/domain/dashboard/brands";
import type { PlanForEdit } from "@/domain/billing/plans";
import { savePlanAction, type BillingResult } from "../billing-actions";

const CURRENCIES = [
  { code: "INR", label: "INR — rupees", note: "charged to buyers in the Indian subcontinent" },
  { code: "USD", label: "USD — dollars", note: "charged everywhere else" },
] as const;

const YEARS = [1, 2, 3, 4, 5];

export function PlanForm({ brands, plan }: { brands: Brand[]; plan?: PlanForEdit }) {
  const [state, action, pending] = useActionState(savePlanAction, null as BillingResult);
  const [chosen, setChosen] = useState<string[]>(plan?.sites ?? (brands.length === 1 ? [brands[0]!.slug] : []));
  const [currencies, setCurrencies] = useState<string[]>(plan?.currencies.length ? plan.currencies : ["INR", "USD"]);
  const [onSale, setOnSale] = useState(plan?.on_sale ?? false);

  const price = new Map((plan?.terms ?? []).map((term) => [`${term.currency}|${term.years}`, term]));
  const years = [...new Set([...YEARS, ...(plan?.terms ?? []).map((term) => term.years)])].sort((a, b) => a - b);
  const all = brands.length > 0 && brands.every((brand) => chosen.includes(brand.slug));
  const bad = (field: string) => state?.field === field;
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
  const shown = CURRENCIES.filter((currency) => currencies.includes(currency.code));

  return (
    <form action={action}>
      {plan ? <input type="hidden" name="id" value={plan.id} /> : null}

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

      <div className="cols wide">
        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>The plan</h2>
            </div>
            <div className="body">
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" type="text" required maxLength={191} defaultValue={plan?.name ?? ""} aria-invalid={bad("name") || undefined} />
                {plan?.name.includes("{{") ? (
                  <div className="small bad">
                    Carried from the old site with its placeholder still in it. Write the brand&apos;s name in.
                  </div>
                ) : null}
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="description">Description</label>
                <textarea id="description" name="description" rows={4} defaultValue={plan?.description ?? ""} />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>Prices</h2>
              <span className="spacer" />
              <span className="hint">Blank: that term is not offered in that currency.</span>
            </div>
            <div className="body">
              {shown.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Tick a currency to set its prices.
                </p>
              ) : (
                <table className="inputs" aria-invalid={bad("terms") || undefined}>
                  <thead>
                    <tr>
                      <th>Term</th>
                      {shown.map((currency) => (
                        <th key={currency.code} className="num">
                          {currency.code}
                        </th>
                      ))}
                      {onSale
                        ? shown.map((currency) => (
                            <th key={`sale-${currency.code}`} className="num">
                              {currency.code} on sale
                            </th>
                          ))
                        : null}
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((n) => (
                      <tr key={n}>
                        <td>
                          {n} year{n === 1 ? "" : "s"}
                          {onSale
                            ? null
                            : shown.map((currency) => (
                                // Kept while the sale is off, so switching it back on finds its prices.
                                <input
                                  key={`sale-${currency.code}`}
                                  type="hidden"
                                  name={`sale_${currency.code}_${n}`}
                                  value={price.get(`${currency.code}|${n}`)?.sale_amount ?? ""}
                                />
                              ))}
                        </td>
                        {shown.map((currency) => (
                          <td key={currency.code}>
                            <input
                              name={`price_${currency.code}_${n}`}
                              type="text"
                              inputMode="decimal"
                              aria-label={`${n} year ${currency.code} price`}
                              placeholder="—"
                              defaultValue={price.get(`${currency.code}|${n}`)?.amount ?? ""}
                            />
                          </td>
                        ))}
                        {onSale
                          ? shown.map((currency) => (
                              <td key={`sale-${currency.code}`}>
                                <input
                                  name={`sale_${currency.code}_${n}`}
                                  type="text"
                                  inputMode="decimal"
                                  aria-label={`${n} year ${currency.code} sale price`}
                                  placeholder="—"
                                  defaultValue={price.get(`${currency.code}|${n}`)?.sale_amount ?? ""}
                                />
                              </td>
                            ))
                          : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="small muted" style={{ margin: "10px 0 0" }}>
                Commas are fine: 1,50,000.{" "}
                {onSale
                  ? "While on sale the checkout charges the sale price, and shows the regular one struck through. A term with no sale price sells at its regular price."
                  : "Tick On sale to give terms a lower price for a while."}
              </p>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>Sold on</h2>
            </div>
            <div className="body">
              <div className="checks" aria-invalid={bad("sites") || undefined}>
                {brands.length > 1 ? (
                  <label className="check all">
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={(event) => setChosen(event.target.checked ? brands.map((brand) => brand.slug) : [])}
                    />
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
                      onChange={(event) => setChosen(toggle(chosen, brand.slug, event.target.checked))}
                    />
                    {brand.name}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>Currencies</h2>
            </div>
            <div className="body">
              <div className="checks" aria-invalid={bad("currencies") || undefined}>
                {CURRENCIES.map((currency) => (
                  <label className="check" key={currency.code} style={{ alignItems: "flex-start" }}>
                    <input
                      type="checkbox"
                      name="currency"
                      value={currency.code}
                      checked={currencies.includes(currency.code)}
                      onChange={(event) => setCurrencies(toggle(currencies, currency.code, event.target.checked))}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      {currency.label}
                      <span className="small muted" style={{ display: "block", fontWeight: 400 }}>
                        {currency.note}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="small muted" style={{ margin: "10px 0 0" }}>
                With both ticked, the buyer&apos;s country decides which price they pay.
              </p>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>Selling it</h2>
            </div>
            <div className="body">
              <div className="checks" style={{ gridTemplateColumns: "1fr" }}>
                <label className="check">
                  <input type="checkbox" name="visible" defaultChecked={plan?.visible ?? true} />
                  Shown on the brand sites
                </label>
                <label className="check">
                  <input type="checkbox" name="on_sale" checked={onSale} onChange={(event) => setOnSale(event.target.checked)} />
                  On sale: charge the sale prices
                </label>
              </div>

              <div className="field" style={{ margin: "14px 0 0" }}>
                <label htmlFor="sort_order">Position in the list</label>
                <input id="sort_order" name="sort_order" type="number" step={1} defaultValue={plan?.sort_order ?? 0} style={{ maxWidth: 120 }} />
              </div>

              {plan ? (
                <p className="small muted" style={{ margin: "14px 0 0" }}>
                  Code <code>{plan.code}</code>. Plans are hidden, never deleted: orders point at them.
                </p>
              ) : null}
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending || (plan !== undefined && !plan.editable)}>
              {pending ? "Saving…" : plan ? "Save" : "Create plan"}
            </button>
            <Link className="button ghost" href="/dashboard/plans">
              {plan ? "Back to plans" : "Cancel"}
            </Link>
          </div>
          {plan && !plan.editable ? (
            <p className="small muted" style={{ margin: 0 }}>
              This plan is also sold on brands you do not manage, so only a superadmin can change it.
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
