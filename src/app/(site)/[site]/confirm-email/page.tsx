/**
 * Where the link mailed to a member's new address lands. Moving the sign-in
 * takes a press of the button: mail scanners open links, and opening must
 * not be enough.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { liveBrandBySlug } from "@/lib/public/reader";
import { confirmNewEmail } from "../actions";
import { ReaderForm } from "../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirm your new email" };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ token?: string }> };

export default async function ConfirmNewEmail({ params, searchParams }: Props) {
  const { site } = await params;
  const { token = "" } = await searchParams;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  return (
    <div className="bs-narrow">
      <section className="bs-card">
        <h1 className="bs-title">Confirm your new email address</h1>
        {token ? (
          <ReaderForm
            action={confirmNewEmail}
            site={site}
            hidden={{ token: String(token) }}
            submit="Use this address"
            busy="Changing…"
            after={
              <p className="bs-after">
                <Link className="btn" href={`/${site}/account`}>
                  Go to my account
                </Link>
              </p>
            }
          >
            <p className="muted">One press and you sign in to {brand.name} with this address from now on.</p>
          </ReaderForm>
        ) : (
          <p className="muted">This page needs the link from your email.</p>
        )}
      </section>
    </div>
  );
}
