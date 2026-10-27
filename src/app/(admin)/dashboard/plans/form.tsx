"use client";

/**
 * A plan: its name, currency and a price for each term it is sold for.
 *
 * A blank price means that term is not offered. Prices here are what the
 * checkout charges from now on; every order already placed keeps its own.
 */

import { useActionState } from "react";
import Link from "next/link";

import type { Brand } from "@/domain/dashboard/brands";
import type { PlanForEdit } from "@/domain/billing/plans";
import { savePlanAction, type BillingResult } from "../billing-actions";

export function PlanForm({ brands, plan }: { brands: Brand[]; plan?: PlanForEdit }) {
  const [state, action, pending] = useActionState(savePlanAction, null as BillingResult);
  const priced = new Map((plan?.terms ?? []).map((term) => [term.years, term.amount]));
  const years = [...new Set([1, 2, 3, 4, 5, ...priced.keys()])].sort((a, b) => a - b);
  const bad = (field: string) => state?.field === field || undefined;

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
        <div className="panel">
          <div className="head">
            <h2>The plan</h2>
          </div>
          <div className="body">
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" required maxLength={191} defaultValue={plan?.name ?? ""} aria-invalid={bad("name")} />
              {plan?.name.includes("{{") ? (
                <div className="small bad">
                  Carried from the old site with its placeholder still in it. The old site filled it in as the page was
                  shown; this one shows it as typed, so write the brand&apos;s name in.
                </div>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea id="description" name="description" rows={4} defaultValue={plan?.description ?? ""} />
            </div>

            <fieldset style={{ border: 0, padding: 0, margin: 0 }} aria-invalid={bad("terms")}>
              <legend className="small" style={{ fontWeight: 600 }}>
                Price for each term
              </legend>
              <div className="bar">
                {years.map((n) => (
                  <div className="field" key={n}>
                    <label htmlFor={`term_${n}`}>
                      {n} year{n === 1 ? "" : "s"}
                    </label>
                    <input
                      id={`term_${n}`}
                      name={`term_${n}`}
                      type="text"
                      inputMode="decimal"
                      size={10}
                      placeholder="not offered"
                      defaultValue={priced.get(n) ?? ""}
                    />
                  </div>
                ))}
              </div>
              <div className="small muted">Leave a term blank to stop offering it. Commas are fine: 1,50,000.</div>
            </fieldset>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="head">
              <h2>Selling it</h2>
            </div>
            <div className="body">
              {plan ? (
                <dl className="kv">
                  <dt>Brand</dt>
                  <dd>{plan.site_name}</dd>
                  <dt>Code</dt>
                  <dd>
                    <code>{plan.code}</code>
                  </dd>
                </dl>
              ) : (
                <div className="field">
                  <label htmlFor="site">Brand</label>
                  <select id="site" name="site" required defaultValue={brands[0]?.slug ?? ""} aria-invalid={bad("site")}>
                    {brands.map((brand) => (
                      <option key={brand.slug} value={brand.slug}>
                        {brand.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field">
                <label htmlFor="currency">Currency</label>
                <select id="currency" name="currency" defaultValue={plan?.currency ?? "INR"} aria-invalid={bad("currency")}>
                  <option value="INR">INR — rupees</option>
                  <option value="USD">USD — dollars</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="sort_order">Position in the list</label>
                <input id="sort_order" name="sort_order" type="number" step={1} defaultValue={plan?.sort_order ?? 0} />
              </div>

              <div className="field">
                <label>
                  <input type="checkbox" name="visible" defaultChecked={plan?.visible ?? true} /> On sale
                </label>
                <div className="small muted">
                  A hidden plan is off the brand site. Plans are never deleted: orders point at them.
                </div>
              </div>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : plan ? "Save" : "Create plan"}
            </button>
            <Link className="button ghost" href="/dashboard/plans">
              {plan ? "Back to plans" : "Cancel"}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}
