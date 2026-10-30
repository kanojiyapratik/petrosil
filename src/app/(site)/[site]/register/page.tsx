/**
 * A free account on a brand. Free readers see the movements and the market
 * names; the figures come with a subscription, which is the next page.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";

import { COUNTRIES } from "@/domain/geo/countries";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { registerReader } from "../actions";
import { CountryField, Field, ReaderForm } from "../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create an account" };

export default async function Register({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  if ((await readerFor(brand.id)).name) {
    redirect(`/${site}/account`);
  }

  return (
    <div className="bs-narrow wide">
      <section className="bs-card">
        <h1 className="bs-title">Create your {brand.name} account</h1>
        <p className="muted bs-lede">
          Free. You will see every market and which way it moved; prices come with a subscription.
        </p>
        <ReaderForm
          action={registerReader}
          site={site}
          submit="Create account"
          busy="Creating…"
          after={
            <p className="bs-after">
              Once it is confirmed, <Link href={`/${site}/sign-in`}>sign in</Link>.
            </p>
          }
        >
          <div className="bs-fields">
            <Field name="name" label="Your name" autoComplete="name" required />
            <Field name="email" label="Email" type="email" autoComplete="email" required />
            <Field
              name="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              hint="At least 8 characters."
            />
            <CountryField
              countries={COUNTRIES.map((c) => c.name)}
              required
              hint="Decides whether plans are shown in rupees or dollars."
            />
            <Field name="company" label="Company" autoComplete="organization" />
            <Field name="designation" label="Job title" autoComplete="organization-title" />
            <Field name="phone" label="Phone" type="tel" autoComplete="tel" />
            <Field name="city" label="City" autoComplete="address-level2" />
          </div>
        </ReaderForm>
      </section>
      <p className="bs-after muted">
        Already have an account? <Link href={`/${site}/sign-in`}>Sign in</Link>
      </p>
    </div>
  );
}
