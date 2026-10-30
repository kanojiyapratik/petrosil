/** Where the emailed reset link lands. The link is only spent when the new password is accepted. */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { liveBrandBySlug } from "@/lib/public/reader";
import { setNewPassword } from "../actions";
import { Field, ReaderForm } from "../forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set a new password" };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ token?: string }> };

export default async function ResetPassword({ params, searchParams }: Props) {
  const { site } = await params;
  const { token = "" } = await searchParams;

  if (!(await liveBrandBySlug(site))) {
    notFound();
  }

  return (
    <div className="bs-narrow">
      <section className="bs-card">
        <h1 className="bs-title">Set a new password</h1>
        {token ? (
          <ReaderForm
            action={setNewPassword}
            site={site}
            hidden={{ token: String(token) }}
            submit="Set password"
            busy="Saving…"
            after={
              <p className="bs-after">
                <Link className="btn" href={`/${site}/sign-in`}>
                  Sign in
                </Link>
              </p>
            }
          >
            <Field
              name="password"
              label="New password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus
              hint="At least 8 characters. Every device you are signed in on will be signed out."
            />
          </ReaderForm>
        ) : (
          <p className="muted">
            This page needs the link from your email. <Link href={`/${site}/forgot-password`}>Ask for a new one</Link>.
          </p>
        )}
      </section>
    </div>
  );
}
