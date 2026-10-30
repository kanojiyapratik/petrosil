/**
 * The plans, in the reader's own currency, and the way to buy one.
 *
 * Which plans are shown follows `visitorCountry`, the same rule as the API:
 * the profile country, then the CDN's country header, then the browser's
 * time zone (the page asks for it once, below). What is charged follows the
 * buyer's profile country only, so the page can show the wrong currency at
 * worst, never charge it.
 */

import Link from "next/link";
import { Suspense } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { COUNTRIES } from "@/domain/geo/countries";
import { plansFor } from "@/domain/billing/orders";
import { offeredTo, preferredCurrency } from "@/domain/billing/pricing";
import { visitorCountry } from "@/lib/public/route";
import { currentIdentity } from "@/lib/auth/server";
import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { askForTrial } from "../actions";
import { ReaderForm } from "../forms";
import { plainText } from "@/lib/public/html";
import { day } from "../ui";
import { Checkout, TimeZone, type OnSale } from "./checkout";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Subscribe" };

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ tz?: string; plan?: string }>;
};

export default async function Subscription({ params, searchParams }: Props) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const { tz = "", plan: chosen = "" } = await searchParams;
  const [reader, identity] = await Promise.all([readerFor(brand.id), currentIdentity()]);

  const asked = new URL(`http://localhost/?tz=${encodeURIComponent(String(tz))}`);
  const country = await visitorCountry(new Request(asked, { headers: await headers() }), asked, reader.viewer);
  const currency = preferredCurrency(country);

  const plans: OnSale[] = (await plansFor(brand.id))
    .filter((plan) => offeredTo(country, plan.currencies))
    .map((plan) => ({
      code: plan.code,
      name: plan.name,
      description: plan.description ? plainText(plan.description, 400) || null : null,
      on_sale: plan.on_sale,
      terms: plan.terms.filter((term) => term.currency === currency),
    }))
    .filter((plan) => plan.terms.length > 0);

  const held = identity?.memberships.find((m) => m.siteId === brand.id);
  const entitled = reader.entitlement.entitled;

  return (
    <>
      {/* Only a first-time visitor with nothing else to go on needs the browser's zone. */}
      {!country && !tz ? (
        <Suspense fallback={null}>
          <TimeZone />
        </Suspense>
      ) : null}

      <div className="bs-head">
        <div>
          <p className="eyebrow">Subscription</p>
          <h1>Every price on {brand.name}</h1>
        </div>
      </div>

      {entitled && held ? (
        <p className="bs-flash good">
          {held.expiresAt
            ? `Your subscription runs to ${day(held.expiresAt)}. Buying again adds to the end of it.`
            : "You can already see every figure."}
        </p>
      ) : null}

      {plans.length === 0 ? (
        <div className="bs-card bs-empty">
          <p>Nothing is on sale here just now. <Link href={`/${site}/contact-us`}>Contact us</Link> and we will help.</p>
        </div>
      ) : (
        <Checkout
          site={site}
          plans={plans}
          chosen={String(chosen)}
          currency={currency}
          buyer={identity ? { name: identity.user.name, country: identity.user.country ?? null } : null}
          countries={COUNTRIES.map((c) => c.name)}
        />
      )}

      {identity && !entitled ? (
        <section className="bs-card bs-trial">
          <h2>Not sure yet?</h2>
          <p className="muted">Ask for a free trial and our team will set one up for you.</p>
          <ReaderForm action={askForTrial} site={site} submit="Ask for a trial" busy="Sending…">
            <label className="bs-field" data-wide>
              <span>Anything we should know (optional)</span>
              <textarea name="note" rows={3} maxLength={2000} />
            </label>
          </ReaderForm>
        </section>
      ) : null}
    </>
  );
}
