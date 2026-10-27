/** One system email across the brands: its versions, and one to apply to the brands ticked. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalEmail } from "@/domain/global/estate";
import { GlobalEmailForm } from "../../../forms";
import { Heading, Panel } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function GlobalEmailPage({ params }: { params: Promise<{ key: string; variant: string }> }) {
  const viewer = (await currentViewer())!;
  const { key, variant } = await params;
  const [email, brands] = await Promise.all([globalEmail(viewer.siteIds, key, variant), brandsFor(viewer.siteIds)]);

  if (!email) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href="/dashboard/global/emails">
        ← System emails
      </Link>

      <Heading
        title={`${email.title}${variant === "default" ? "" : ` (${variant})`}`}
        sub={
          email.versions.length === 1
            ? "Every brand that has it says the same thing."
            : `${email.versions.length} versions across the brands.`
        }
      />

      <Panel title="Who has which version" flush={false}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {email.versions.map((version, index) => (
            <li key={index} style={{ marginBottom: 6 }}>
              <strong>{version.subject}</strong>
              <div className="small muted">{version.brands.map((brand) => brand.name).join(", ")}</div>
            </li>
          ))}
        </ol>
        {email.missing.length ? (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            Not on {email.missing.map((brand) => brand.name).join(", ")}: applying creates it there.
          </p>
        ) : null}
      </Panel>

      <div style={{ height: 16 }} />

      <GlobalEmailForm
        emailKey={key}
        variant={variant}
        versions={email.versions}
        brands={brands.map(({ slug, name }) => ({ slug, name }))}
      />
    </>
  );
}
