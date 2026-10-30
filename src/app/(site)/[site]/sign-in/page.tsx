/**
 * Signing in to a brand. One account reads every brand it has joined, so
 * this is the same sign-in as the others; only the page around it differs.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";

import { liveBrandBySlug, readerFor } from "@/lib/public/reader";
import { signInReader } from "../actions";
import { Field, ReaderForm } from "../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ next?: string }>;
};

export default async function SignIn({ params, searchParams }: Props) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const { next = "" } = await searchParams;

  if ((await readerFor(brand.id)).name) {
    redirect(`/${site}/account`);
  }

  return (
    <div className="bs-narrow">
      <section className="bs-card">
        <h1 className="bs-title">Sign in to {brand.name}</h1>
        <ReaderForm action={signInReader} site={site} hidden={{ next: String(next) }} submit="Sign in" busy="Signing in…">
          <Field name="email" label="Email" type="email" autoComplete="username" required autoFocus />
          <Field name="password" label="Password" type="password" autoComplete="current-password" required />
        </ReaderForm>
        <p className="bs-after">
          <Link href={`/${site}/forgot-password`}>Forgotten your password?</Link>
        </p>
      </section>
      <p className="bs-after muted">
        New to {brand.name}? <Link href={`/${site}/register`}>Create a free account</Link>, then{" "}
        <Link href={`/${site}/subscription`}>see the plans</Link>.
      </p>
    </div>
  );
}
