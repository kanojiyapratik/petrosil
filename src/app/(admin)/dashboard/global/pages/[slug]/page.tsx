/** One common page across the brands: its versions, and one to apply to the brands ticked. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalPage } from "@/domain/global/estate";
import { GlobalPageForm } from "../../forms";
import { Heading, Panel } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;

export default async function GlobalPageEditor({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const [page, brands] = await Promise.all([globalPage(viewer.siteIds, slug), brandsFor(viewer.siteIds)]);

  if (!page) {
    notFound();
  }

  return (
    <>
      <Link className="crumb" href="/dashboard/global/pages">
        ← Common pages
      </Link>

      <Heading
        title={page.versions[0]!.title}
        sub={`/${slug} · ${
          page.versions.length === 1
            ? "every brand that has it says the same thing"
            : `${page.versions.length} versions across the brands`
        }`}
      />

      <Panel title="Who has which version" flush={false}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {page.versions.map((version, index) => (
            <li key={index} style={{ marginBottom: 6 }}>
              <strong>{version.title}</strong>
              <span className="small muted"> · {words(version.body)} words</span>
              <div className="small muted">{version.brands.map((brand) => brand.name).join(", ")}</div>
            </li>
          ))}
        </ol>
        {page.missing.length ? (
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            Not on {page.missing.map((brand) => brand.name).join(", ")}: applying creates it there.
          </p>
        ) : null}
      </Panel>

      <div style={{ height: 16 }} />

      <GlobalPageForm
        slug={slug}
        versions={page.versions}
        brands={brands.map(({ slug: brandSlug, name }) => ({ slug: brandSlug, name }))}
      />
    </>
  );
}
