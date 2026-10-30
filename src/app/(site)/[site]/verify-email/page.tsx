/**
 * Where the confirmation link lands. Confirming takes a press of the button:
 * mail scanners open links, and opening must not be enough.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { liveBrandBySlug } from "@/lib/public/reader";
import { confirmAddress } from "../actions";
import { ReaderForm } from "../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirm your email" };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ token?: string }> };

export default async function VerifyEmail({ params, searchParams }: Props) {
  const { site } = await params;
  const { token = "" } = await searchParams;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  return (
    <div className="bs-narrow">
      <section className="bs-card">
        <h1 className="bs-title">Confirm your email address</h1>
        {token ? (
          <ReaderForm
            action={confirmAddress}
            site={site}
            hidden={{ token: String(token) }}
            submit="Confirm my address"
            busy="Confirming…"
            after={
              <p className="bs-after">
                <Link className="btn" href={`/${site}/sign-in`}>
                  Sign in to {brand.name}
                </Link>
              </p>
            }
          >
            <p className="muted">One press and your {brand.name} account is ready.</p>
          </ReaderForm>
        ) : (
          <p className="muted">This page needs the link from your email.</p>
        )}
      </section>
    </div>
  );
}
