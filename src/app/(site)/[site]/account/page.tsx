/**
 * A reader's own page: what they hold on this brand and the others, their
 * invoices, their details, their sign-in address and their password.
 */

import Link from "@/lib/ui/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";

import { COUNTRIES } from "@/domain/geo/countries";
import { inArray } from "drizzle-orm";

import { db } from "@/db";
import { sites } from "@/db/schema";
import { ordersFor } from "@/domain/billing/orders";
import { currentIdentity } from "@/lib/auth/server";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { pendingEmailChange } from "@/domain/accounts/email-change";
import { askForNewEmail, saveProfile, savePassword, signOutReader } from "../actions";
import { CountryField, Field, ReaderForm } from "../forms";
import { day } from "../ui";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My account" };

const STATUS: Record<string, string> = {
  premium: "Subscriber",
  trial: "Free trial",
  team: "Team access",
  free: "Free account",
  expired: "Subscription ended",
  no_membership: "Not joined",
};

const ORDER_STATUS: Record<string, string> = {
  paid: "Paid",
  pending: "Not paid",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default async function Account({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const identity = await currentIdentity();

  if (!identity) {
    redirect(`/${site}/sign-in?next=${encodeURIComponent(`/${site}/account`)}`);
  }

  const others = identity.memberships.filter((m) => m.siteId !== brand.id);
  const [reader, orders, pending, named] = await Promise.all([
    readerFor(brand.id),
    ordersFor(identity.user.id),
    pendingEmailChange(identity.user.id),
    others.length > 0
      ? db().select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, others.map((m) => m.siteId)))
      : [],
  ]);
  const nameOf = new Map(named.map((row) => [row.id, row.name]));
  const brandName = new Map([[brand.slug, brand.name], ...others.map((m) => [m.slug, nameOf.get(m.siteId) ?? m.slug] as const)]);
  const me = identity.user;
  const reason = reader.entitlement.reason;
  const here = identity.memberships.find((m) => m.siteId === brand.id);

  return (
    <>
      <div className="bs-head">
        <div className="bs-acct-head">
          <span className="av" aria-hidden>
            {me.name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((word) => word[0]!.toUpperCase())
              .join("")}
          </span>
          <div>
            <p className="eyebrow" style={{ margin: 0 }}>
              My account
            </p>
            <h1>{me.name}</h1>
            <p className="muted bs-email">{me.email}</p>
          </div>
        </div>
        <form action={signOutReader} className="more">
          <input type="hidden" name="site" value={site} />
          <button className="btn ghost" type="submit">
            Sign out
          </button>
        </form>
      </div>

      {!me.emailVerifiedAt ? (
        <p className="bs-flash">Your email address is not confirmed yet — the link is in the email we sent when you joined.</p>
      ) : null}

      <div className="bs-grid">
        <div className="bs-stack">
          <section className="bs-card">
            <h2>My subscription</h2>
            <div className="bs-standing">
              <div>
                <span className="muted" style={{ fontSize: 14 }}>
                  {brand.name}
                </span>
                <strong>{STATUS[reason] ?? reason}</strong>
                {here?.expiresAt ? (
                  <span className="muted" style={{ fontSize: 14 }}>
                    {reader.entitlement.entitled ? "Runs to" : "Ended"} {day(here.expiresAt)}
                  </span>
                ) : null}
              </div>
              <Link className="btn" href={`/${site}/subscription`}>
                {reader.entitlement.entitled ? "Extend my subscription" : "Subscribe"}
              </Link>
            </div>
            {others.length > 0 ? (
              <>
                <h3>Your other brands</h3>
                <ul className="bs-brands">
                  {others.map((m) => {
                    const ended = m.tier !== "free" && m.expiresAt !== null && new Date(m.expiresAt).getTime() < Date.now();

                    return (
                      <li key={m.siteId}>
                        <Link href={`/${m.slug}`}>{nameOf.get(m.siteId) ?? m.slug}</Link>
                        <span className={`bs-pill${m.tier === "free" ? "" : ended ? " off" : " on"}`}>
                          {m.tier === "free" ? "Free" : m.expiresAt ? `${ended ? "Ended" : "To"} ${day(m.expiresAt)}` : m.tier}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </section>

          <section className="bs-card">
            <h2>Invoices</h2>
            {orders.length === 0 ? (
              <p className="muted">Nothing bought yet.</p>
            ) : (
              <div className="bs-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Brand</th>
                      <th>Plan</th>
                      <th className="r">Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td className="num nowrap">{day(o.created_at)}</td>
                        <td>{brandName.get(o.site) ?? o.site}</td>
                        <td>
                          {o.plan_name}, {o.years === 1 ? "1 year" : `${o.years} years`}
                        </td>
                        <td className="r num nowrap">
                          {Number(o.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} {o.currency}
                        </td>
                        <td>
                          <span className={`bs-pill${o.status === "paid" ? " on" : o.status === "failed" ? " off" : ""}`}>
                            {ORDER_STATUS[o.status] ?? o.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bs-card">
            <h2>Email address</h2>
            <p>
              You sign in with <strong>{me.email}</strong>.
            </p>
            {pending ? (
              <p className="bs-flash">
                Waiting for you to confirm <strong>{pending}</strong> — press the button in the email we sent there. Until then, keep signing in with your current address.
              </p>
            ) : null}
            <ReaderForm action={askForNewEmail} site={site} submit="Change email address" busy="Sending…">
              <Field name="email" label="New email address" type="email" autoComplete="email" required />
              <Field
                name="password"
                label="Current password"
                type="password"
                autoComplete="current-password"
                required
                hint="We email a link to the new address. Nothing changes until you press it."
              />
            </ReaderForm>
          </section>
        </div>

        <div className="bs-stack">
          <section className="bs-card">
            <h2>My details</h2>
            <ReaderForm action={saveProfile} site={site} submit="Save" busy="Saving…" keepOpen>
              <div className="bs-fields">
                <Field name="name" label="Name" defaultValue={me.name} autoComplete="name" required />
                <CountryField countries={COUNTRIES.map((c) => c.name)} value={me.country} />
                <Field name="company" label="Company" defaultValue={me.company ?? ""} autoComplete="organization" />
                <Field name="designation" label="Job title" defaultValue={me.designation ?? ""} />
                <Field name="phone" label="Phone" type="tel" defaultValue={me.phone ?? ""} autoComplete="tel" />
                <Field name="city" label="City" defaultValue={me.city ?? ""} autoComplete="address-level2" />
                <Field name="website" label="Website" defaultValue={me.website ?? ""} wide />
              </div>
            </ReaderForm>
          </section>
          <section className="bs-card">
            <h2>Password</h2>
            <ReaderForm action={savePassword} site={site} submit="Change password" busy="Saving…">
              <Field name="current" label="Current password" type="password" autoComplete="current-password" required />
              <Field
                name="next"
                label="New password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                hint="Your other devices will be signed out."
              />
            </ReaderForm>
          </section>
        </div>
      </div>
    </>
  );
}
