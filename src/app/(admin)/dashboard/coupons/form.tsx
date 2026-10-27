"use client";

/** A discount code: what it takes off, where, how often and when. */

import { useActionState, useState } from "react";
import Link from "next/link";

import type { Brand } from "@/domain/dashboard/brands";
import type { CouponForEdit } from "@/domain/billing/coupons";
import { saveCouponAction, type BillingResult } from "../billing-actions";

export function CouponForm({
  brands,
  coupon,
  superadmin,
}: {
  brands: Brand[];
  coupon?: CouponForEdit;
  superadmin: boolean;
}) {
  const [state, action, pending] = useActionState(saveCouponAction, null as BillingResult);
  const [kind, setKind] = useState(coupon?.kind ?? "percent");
  const bad = (field: string) => state?.field === field || undefined;

  return (
    <form action={action}>
      {coupon ? <input type="hidden" name="id" value={coupon.id} /> : null}

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
          <label htmlFor="code">Code</label>
          <input
            id="code"
            name="code"
            type="text"
            required
            maxLength={64}
            defaultValue={coupon?.code ?? ""}
            style={{ textTransform: "uppercase" }}
            aria-invalid={bad("code")}
          />
        </div>

        {coupon ? (
          <div className="field">
            <label>Works on</label>
            <div>{coupon.site ?? "every brand"}</div>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="site">Works on</label>
            <select id="site" name="site" defaultValue={brands[0]?.slug ?? ""} aria-invalid={bad("site")}>
              {brands.map((brand) => (
                <option key={brand.slug} value={brand.slug}>
                  {brand.name}
                </option>
              ))}
              {superadmin ? <option value="">Every brand</option> : null}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="kind">Takes off</label>
          <select id="kind" name="kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="percent">A percentage</option>
            <option value="amount">A fixed amount</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="value">{kind === "percent" ? "Percent" : "Amount"}</label>
          <input
            id="value"
            name="value"
            type="text"
            inputMode="decimal"
            size={8}
            required
            defaultValue={coupon?.value ?? ""}
            aria-invalid={bad("value")}
          />
        </div>

        {kind === "amount" ? (
          <div className="field">
            <label htmlFor="currency">Currency</label>
            <select id="currency" name="currency" defaultValue={coupon?.currency ?? "INR"} aria-invalid={bad("currency")}>
              <option value="INR">INR</option>
              <option value="USD">USD</option>
            </select>
          </div>
        ) : null}
      </div>

      <div className="bar">
        <div className="field">
          <label htmlFor="max_redemptions">Uses allowed</label>
          <input
            id="max_redemptions"
            name="max_redemptions"
            type="number"
            min={1}
            step={1}
            placeholder="no cap"
            defaultValue={coupon?.max_redemptions ?? ""}
            aria-invalid={bad("max_redemptions")}
          />
          {coupon ? <div className="small muted">used {coupon.redeemed} times</div> : null}
        </div>
        <div className="field">
          <label htmlFor="starts_at">From</label>
          <input id="starts_at" name="starts_at" type="date" defaultValue={coupon?.starts_at ?? ""} aria-invalid={bad("starts_at")} />
        </div>
        <div className="field">
          <label htmlFor="expires_at">Until (last day it works)</label>
          <input id="expires_at" name="expires_at" type="date" defaultValue={coupon?.expires_at ?? ""} aria-invalid={bad("expires_at")} />
        </div>
        <div className="field">
          <label>
            <input type="checkbox" name="enabled" defaultChecked={coupon?.enabled ?? true} /> Switched on
          </label>
        </div>
      </div>

      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : coupon ? "Save" : "Create code"}
        </button>
        {coupon ? (
          <Link className="button ghost" href="/dashboard/coupons">
            Back to coupons
          </Link>
        ) : null}
      </div>
    </form>
  );
}
