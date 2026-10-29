"use client";

/**
 * Record a payment the team took by hand: the old admin's "mark as paid".
 *
 * Choosing a plan and term fills in its list price, which is then usually
 * typed over with what was actually agreed. Leave "Access until" blank for
 * the usual rule: a running subscription is extended from its end, a lapsed
 * one starts from the payment date.
 */

import { useActionState, useState } from "react";

import { recordPaymentAction, type BillingResult } from "../../billing-actions";

type Plan = {
  id: number;
  name: string;
  visible: boolean;
  sites: { slug: string }[];
  currencies: string[];
  terms: { currency: string; years: number; amount: number }[];
};

export function PaymentForm({
  userId,
  brands,
  plans,
  methods,
  defaultSite,
  defaultCurrency,
  today,
}: {
  userId: number;
  brands: { slug: string; name: string }[];
  plans: Plan[];
  methods: readonly { key: string; label: string }[];
  defaultSite: string;
  /** INR for a reader in the Indian subcontinent, otherwise USD: the checkout's rule. */
  defaultCurrency: string;
  today: string;
}) {
  const [state, action, pending] = useActionState(recordPaymentAction, null as BillingResult);
  const [site, setSite] = useState(defaultSite);
  const offered = plans.filter((plan) => plan.sites.some((brand) => brand.slug === site));
  const [planId, setPlanId] = useState<number | null>(offered[0]?.id ?? null);
  const plan = offered.find((row) => row.id === planId) ?? offered[0];
  const [years, setYears] = useState(1);
  const [wanted, setWanted] = useState(defaultCurrency);
  const currencyOf = (row: Plan | undefined) =>
    row?.currencies.includes(wanted) ? wanted : (row?.currencies[0] ?? wanted);
  const currency = currencyOf(plan);
  const list = plan?.terms.find((term) => term.years === years && term.currency === currency)?.amount;
  const [amount, setAmount] = useState(list !== undefined ? String(list) : "");
  const bad = (field: string) => state?.field === field || undefined;

  const pick = (nextPlan: Plan | undefined, nextYears: number, nextCurrency = currencyOf(nextPlan)) => {
    const price = nextPlan?.terms.find((term) => term.years === nextYears && term.currency === nextCurrency)?.amount;

    setAmount(price !== undefined ? String(price) : "");
  };

  return (
    <form action={action}>
      <input type="hidden" name="user_id" value={userId} />

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
        <div className="field">
          <label htmlFor="pay-site">Brand</label>
          <select
            id="pay-site"
            name="site"
            value={site}
            onChange={(event) => {
              const next = plans.filter((row) => row.sites.some((brand) => brand.slug === event.target.value));

              setSite(event.target.value);
              setPlanId(next[0]?.id ?? null);
              pick(next[0], years);
            }}
          >
            {brands.map((brand) => (
              <option key={brand.slug} value={brand.slug}>
                {brand.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field grow">
          <label htmlFor="pay-plan">Plan</label>
          <select
            id="pay-plan"
            name="plan_id"
            value={plan?.id ?? ""}
            required
            aria-invalid={bad("plan_id")}
            onChange={(event) => {
              const next = offered.find((row) => row.id === Number(event.target.value));

              setPlanId(Number(event.target.value));
              pick(next, years);
            }}
          >
            {offered.length === 0 ? <option value="">This brand has no plans</option> : null}
            {offered.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · {row.currencies.join("/") || "no prices"}
                {row.visible ? "" : " (hidden)"}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pay-years">Years</label>
          <input
            id="pay-years"
            name="years"
            type="number"
            min={1}
            max={10}
            step={1}
            value={years}
            aria-invalid={bad("years")}
            onChange={(event) => {
              const next = Number(event.target.value);

              setYears(next);
              pick(plan, next);
            }}
            style={{ width: "5em" }}
          />
        </div>

        <div className="field">
          <label htmlFor="pay-currency">Currency</label>
          <select
            id="pay-currency"
            name="currency"
            value={currency}
            aria-invalid={bad("currency")}
            onChange={(event) => {
              setWanted(event.target.value);
              pick(plan, years, event.target.value);
            }}
          >
            {(plan?.currencies ?? []).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pay-amount">Amount paid</label>
          <input
            id="pay-amount"
            name="amount"
            type="text"
            inputMode="decimal"
            required
            size={10}
            value={amount}
            aria-invalid={bad("amount")}
            onChange={(event) => setAmount(event.target.value)}
          />
          <div className="small muted">{list !== undefined ? `list price ${list.toLocaleString("en-IN")}` : "no list price for this term"}</div>
        </div>
      </div>

      <div className="bar">
        <div className="field">
          <label htmlFor="pay-method">Paid by</label>
          <select id="pay-method" name="method" defaultValue="bank" aria-invalid={bad("method")}>
            {methods.map((method) => (
              <option key={method.key} value={method.key}>
                {method.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="pay-reference">Transaction, UTR or cheque number</label>
          <input id="pay-reference" name="reference" type="text" maxLength={191} aria-invalid={bad("reference")} />
        </div>
        <div className="field">
          <label htmlFor="pay-on">Paid on</label>
          <input id="pay-on" name="paid_on" type="date" max={today} defaultValue={today} aria-invalid={bad("paid_on")} />
        </div>
        <div className="field">
          <label htmlFor="pay-until">Access until</label>
          <input id="pay-until" name="until" type="date" aria-invalid={bad("until")} />
          <div className="small muted">blank: the usual term</div>
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending || !plan}>
          {pending ? "Recording…" : "Record payment"}
        </button>
      </div>
    </form>
  );
}
