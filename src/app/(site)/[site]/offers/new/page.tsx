/** Posting an offer. It goes live at once; staff can suspend it. */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";

import { COUNTRIES } from "@/domain/geo/countries";
import { currentIdentity } from "@/lib/auth/server";
import { liveBrandBySlug } from "@/lib/public/reader";
import { postBrandOffer } from "../../actions";
import { CountryField, Field, ReaderForm } from "../../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Post an offer" };

export default async function NewOffer({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const identity = await currentIdentity();

  if (!identity) {
    redirect(`/${site}/sign-in?next=${encodeURIComponent(`/${site}/offers/new`)}`);
  }

  const me = identity.user;

  return (
    <div className="bs-narrow wide">
      <section className="bs-card">
        <Link className="bs-crumb" href={`/${site}/offers`}>
          ← Offers
        </Link>
        <h1 className="bs-title">Post an offer</h1>
        <p className="muted bs-lede">It goes up straight away. You can take it down again from My offers.</p>
        <ReaderForm action={postBrandOffer} site={site} submit="Post the offer" busy="Posting…">
          <fieldset className="bs-choice">
            <legend>I want to</legend>
            <label>
              <input type="radio" name="offer_type" value="sell" defaultChecked /> Sell
            </label>
            <label>
              <input type="radio" name="offer_type" value="buy" /> Buy
            </label>
          </fieldset>
          <div className="bs-fields">
            <Field name="subject" label="What is it?" required maxLength={255} wide hint="For example: SN 500 Group I, 2,000 t, CFR Mumbai" />
            <label className="bs-field" data-name="description" data-wide>
              <span>Details</span>
              <textarea name="description" rows={6} maxLength={20000} />
            </label>
            <Field name="offer_value" label="Price or value (optional)" maxLength={64} />
            <Field name="keywords" label="Keywords (optional)" maxLength={255} hint="Help people find it in search." />
            <Field name="company_name" label="Company" defaultValue={me.company ?? ""} maxLength={191} />
            <CountryField countries={COUNTRIES.map((c) => c.name)} value={me.country} />
            <Field name="city" label="City" defaultValue={me.city ?? ""} maxLength={96} />
            <Field name="contact_person" label="Contact person" defaultValue={me.name} maxLength={191} />
            <Field name="contact_email" label="Contact email" type="email" defaultValue={me.email} />
            <Field name="contact_phone" label="Contact phone" type="tel" defaultValue={me.phone ?? ""} maxLength={64} />
          </div>
        </ReaderForm>
      </section>
    </div>
  );
}
