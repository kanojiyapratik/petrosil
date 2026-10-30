/**
 * "Write to them": the message box under a listed company or an offer.
 *
 * The page only decides what to draw. Whether the message is allowed —
 * signed in, the brand's field rules, the hourly limit — is decided again by
 * `submitEnquiry` when it arrives.
 */

import Link from "next/link";

import { sendEnquiry } from "./actions";
import { Field, ReaderForm } from "./forms";

export function MessageBox({
  site,
  kind,
  to,
  allowed,
  signedIn,
  back,
  title,
  subject,
}: {
  site: string;
  kind: "company" | "offer";
  to: number;
  /** The brand's rule for this reader: may they write through the site at all? */
  allowed: boolean;
  signedIn: boolean;
  back: string;
  title: string;
  subject?: string;
}) {
  if (!signedIn) {
    return (
      <div className="bs-gate">
        <span>Sign in to send a message.</span>
        <Link className="btn" href={`/${site}/sign-in?next=${encodeURIComponent(back)}`}>
          Sign in
        </Link>
        <Link href={`/${site}/register`}>Create a free account</Link>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="bs-gate">
        <span>Messages through the site are for subscribers.</span>
        <Link className="btn" href={`/${site}/subscription`}>
          See the plans
        </Link>
      </div>
    );
  }

  return (
    <section className="bs-message">
      <h2>{title}</h2>
      <ReaderForm action={sendEnquiry} site={site} hidden={{ kind, to: String(to) }} submit="Send" busy="Sending…">
        <Field name="subject" label="Subject" defaultValue={subject} maxLength={255} />
        <label className="bs-field" data-name="message">
          <span>Message</span>
          <textarea name="message" rows={5} required maxLength={5000} />
          <small>Your name and email address go with it, so they can reply to you.</small>
        </label>
      </ReaderForm>
    </section>
  );
}
