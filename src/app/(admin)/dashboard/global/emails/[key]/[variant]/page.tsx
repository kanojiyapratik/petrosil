/**
 * One system email across the brands: edit it and apply it to the brands
 * ticked.
 *
 * The editor is the page: the brands' wordings as a strip to start from,
 * the subject, and the message in a visual editor (HTML one tab away).
 * Beside it, what sends the email, the placeholders it can use, and the
 * brands to apply it to. It used to open on a numbered list of seven
 * identical-looking subjects, with the message as a box of raw HTML below.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalEmail } from "@/domain/global/estate";
import { emailSender } from "@/domain/content/mail-templates";
import { GlobalEmailForm } from "../../../forms";
import { Heading } from "@/app/(admin)/ui";
import { WHEN_LABEL, emailAbout, placeholdersIn } from "../../about";

export const dynamic = "force-dynamic";

export default async function GlobalEmailPage({ params }: { params: Promise<{ key: string; variant: string }> }) {
  const viewer = (await currentViewer())!;
  const { key, variant } = await params;
  const [email, brands] = await Promise.all([globalEmail(viewer.siteIds, key, variant), brandsFor(viewer.siteIds)]);

  if (!email) {
    notFound();
  }

  const about = emailAbout(key);
  const when = about ? WHEN_LABEL[about.when] : null;
  // What the sender fills, then anything else the brands' wordings already use.
  const placeholders = [
    ...new Set([
      ...(emailSender(key)?.fields ?? []),
      ...placeholdersIn(...email.versions.flatMap((version) => [version.subject, version.body])),
    ]),
  ].filter((name) => name !== "brand");

  return (
    <>
      <nav className="crumbs" aria-label="Where you are">
        <Link href="/dashboard/global/emails">System emails</Link>
        <span aria-hidden="true">/</span>
        <strong>{email.title}</strong>
      </nav>

      <Heading
        title={`${email.title}${variant === "default" ? "" : ` (${variant})`}`}
        sub={
          email.versions.length === 1
            ? "Every brand that has it says the same thing."
            : `The brands word it ${email.versions.length} different ways. Pick one to start from, edit it, and apply it to the brands you choose.`
        }
      >
        {when ? <span className={`badge ${when.tone}`}>{when.label}</span> : null}
      </Heading>

      <GlobalEmailForm
        emailKey={key}
        variant={variant}
        versions={email.versions}
        brands={brands.map(({ slug, name }) => ({ slug, name }))}
        missing={email.missing.map(({ slug, name }) => ({ slug, name }))}
        placeholders={placeholders}
        about={about}
      />
    </>
  );
}
