/**
 * Field visibility, across the brands: which directory and offer details
 * free and paying readers see.
 *
 * The rules were set nine times over and are nearly the same everywhere, so
 * each field shows whether the brands agree, and one rule is applied to the
 * brands ticked. A brand's own settings screen still sets its rules alone.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalFields } from "@/domain/global/estate";
import { VisibilityTable } from "../forms";
import { Heading } from "@/app/(admin)/ui";

export const metadata = { title: "Field visibility · Petrosil" };
export const dynamic = "force-dynamic";

export default async function GlobalVisibilityPage() {
  const viewer = (await currentViewer())!;
  const [brands, directory, offer] = await Promise.all([
    brandsFor(viewer.siteIds),
    globalFields(viewer.siteIds, "directory"),
    globalFields(viewer.siteIds, "offer"),
  ]);

  return (
    <>
      <Heading
        title="Field visibility"
        sub="Which details of a member's listing and of an offer free and paying readers see, across the brands."
      />

      <VisibilityTable
        brands={brands.map(({ slug, name }) => ({ slug, name }))}
        forms={[
          { form: "directory", title: "Member directory", rows: directory },
          { form: "offer", title: "Offers", rows: offer },
        ]}
      />
    </>
  );
}
