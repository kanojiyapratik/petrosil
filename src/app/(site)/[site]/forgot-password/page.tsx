import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { liveBrandBySlug } from "@/lib/public/reader";
import { forgotPassword } from "../actions";
import { Field, ReaderForm } from "../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Forgotten password" };

export default async function ForgotPassword({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;

  if (!(await liveBrandBySlug(site))) {
    notFound();
  }

  return (
    <div className="bs-narrow">
      <section className="bs-card">
        <h1 className="bs-title">Forgotten your password?</h1>
        <p className="muted bs-lede">We will email you a link to set a new one.</p>
        <ReaderForm action={forgotPassword} site={site} submit="Email me a link" busy="Sending…">
          <Field name="email" label="Email" type="email" autoComplete="username" required autoFocus />
        </ReaderForm>
      </section>
      <p className="bs-after muted">
        <Link href={`/${site}/sign-in`}>Back to sign in</Link>
      </p>
    </div>
  );
}
