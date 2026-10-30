"use client";

/**
 * Choosing a plan and paying for it.
 *
 * Two steps on purpose. "Continue" places the order, and the server prices it
 * (coupon and sale included); the reader then sees the exact total before
 * Razorpay's window opens. Paying is checked by signature on the server — the
 * browser saying "paid" grants nothing.
 */

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { placeBrandOrder, settleBrandOrder, type Placed } from "../actions";
import type { Checkout as Pay, OrderView } from "@/domain/billing/orders";

export type OnSale = {
  code: string;
  name: string;
  description: string | null;
  on_sale: boolean;
  terms: { currency: string; years: number; amount: string; sale_amount: string | null }[];
};

const money = (amount: string | number, currency: string) =>
  new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount));

/** "30 Oct 2028" from a Y-m-d, matching the dates elsewhere on the site. */
const day = (ymd: string) =>
  new Date(`${ymd.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const span = (years: number) => (years === 1 ? "1 year" : `${years} years`);

/** Sends the browser's time zone once, so a first visit is shown its own currency. */
export function TimeZone() {
  const router = useRouter();
  const path = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (zone && !search.get("tz")) {
      const next = new URLSearchParams(search.toString());

      next.set("tz", zone);
      router.replace(`${path}?${next.toString()}`, { scroll: false });
    }
  }, [router, path, search]);

  return null;
}

type RazorpayHandler = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void };
  }
}

function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const script = document.createElement("script");

    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export function Checkout({
  site,
  plans,
  chosen,
  currency,
  buyer,
  countries,
}: {
  site: string;
  plans: OnSale[];
  chosen: string;
  currency: string;
  buyer: { name: string; country: string | null } | null;
  countries: string[];
}) {
  const first = plans.find((p) => p.code === chosen) ?? plans[0]!;
  const [pick, setPick] = useState(`${first.code}:${first.terms[0]!.years}`);
  const [code, setCode] = useState("");
  const [country, setCountry] = useState("");
  const [placed, setPlaced] = useState<{ order: OrderView; checkout: Pay | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState<OrderView | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();

  const [planCode, yearsText] = pick.split(":");
  const here = `/${site}/subscription?plan=${encodeURIComponent(planCode ?? "")}`;

  const answer = (result: Placed) => {
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setError(null);

    if (result.order.status === "paid") {
      setPaid(result.order);
      router.refresh();
      return;
    }

    setPlaced({ order: result.order, checkout: result.checkout });
  };

  const order = () =>
    start(async () => {
      answer(await placeBrandOrder({ site, plan: planCode ?? "", years: Number(yearsText), code, country }));
    });

  const pay = (checkout: Pay, orderId: number) =>
    start(async () => {
      if (!(await loadRazorpay()) || !window.Razorpay) {
        setError("The payment window did not load. Check your connection and try again.");
        return;
      }

      new window.Razorpay({
        key: checkout.key,
        order_id: checkout.order_id,
        amount: checkout.amount,
        currency: checkout.currency,
        name: checkout.name,
        prefill: checkout.prefill,
        handler: (response: RazorpayHandler) =>
          start(async () => {
            answer(
              await settleBrandOrder(orderId, {
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            );
          }),
      }).open();
    });

  if (paid) {
    return (
      <section className="bs-card">
        <p className="bs-flash good" role="status">
          Thank you — {paid.plan_name} is yours{paid.granted_until ? ` until ${day(paid.granted_until)}` : ""}. Every figure is
          now open to you.
        </p>
        <p>
          <Link className="btn" href={`/${site}/price-trends`}>
            See the prices
          </Link>
        </p>
      </section>
    );
  }

  if (placed) {
    const { order: o, checkout } = placed;

    return (
      <section className="bs-card bs-review">
        <h2>Your order</h2>
        <dl>
          <dt>Plan</dt>
          <dd>
            {o.plan_name}, {span(o.years)}
          </dd>
          <dt>Price</dt>
          <dd className="num">{money(o.list_amount, o.currency)}</dd>
          {Number(o.discount) > 0 ? (
            <>
              <dt>Discount{o.coupon_code ? ` (${o.coupon_code})` : ""}</dt>
              <dd className="num">−{money(o.discount, o.currency)}</dd>
            </>
          ) : null}
          <dt>To pay</dt>
          <dd className="num total">{money(o.amount, o.currency)}</dd>
        </dl>
        {error ? (
          <p className="bs-flash bad" role="alert">
            {error}
          </p>
        ) : null}
        {checkout ? (
          <div className="bs-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => pay(checkout, o.id)}>
              {busy ? "Opening…" : `Pay ${money(o.amount, o.currency)}`}
            </button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => setPlaced(null)}>
              Change
            </button>
          </div>
        ) : (
          <p className="bs-flash">
            Online payment is not switched on yet. Your order (number {o.id}) is saved and our team will contact you to
            complete it.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="bs-card">
      <div className="bs-plans" role="radiogroup" aria-label="Plans">
        {plans.map((plan) => (
          <div key={plan.code} className="bs-plan">
            <h2>
              {plan.name}
              {plan.on_sale ? <span className="bs-tag">On sale</span> : null}
            </h2>
            {plan.description ? <p className="muted">{plan.description}</p> : null}
            {plan.terms.map((term) => {
              const value = `${plan.code}:${term.years}`;

              return (
                <label key={value} className="bs-term" data-on={pick === value || undefined}>
                  <input
                    type="radio"
                    name="term"
                    value={value}
                    checked={pick === value}
                    onChange={() => setPick(value)}
                  />
                  <span>{span(term.years)}</span>
                  <span className="num">
                    {term.sale_amount ? (
                      <>
                        <s>{money(term.amount, currency)}</s> {money(term.sale_amount, currency)}
                      </>
                    ) : (
                      money(term.amount, currency)
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>

      {buyer ? (
        <div className="bs-form">
          {error ? (
            <p className="bs-flash bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bs-fields">
            <label className="bs-field">
              <span>Discount code (optional)</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
            </label>
            {!buyer.country ? (
              <label className="bs-field">
                <span>Your country</span>
                <select value={country} onChange={(e) => setCountry(e.target.value)} required>
                  <option value="">Choose…</option>
                  {countries.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <small>Saved to your account. It decides whether you pay in rupees or dollars.</small>
              </label>
            ) : null}
          </div>
          <div className="bs-actions">
            <button className="btn" type="button" disabled={busy || (!buyer.country && !country)} onClick={order}>
              {busy ? "Working…" : "Continue"}
            </button>
          </div>
        </div>
      ) : (
        <div className="bs-gate">
          <span>Sign in or create a free account to subscribe.</span>
          <Link className="btn" href={`/${site}/sign-in?next=${encodeURIComponent(here)}`}>
            Sign in
          </Link>
          <Link href={`/${site}/register`}>Create an account</Link>
        </div>
      )}
    </section>
  );
}
