/**
 * Ad slots, across the brands.
 *
 * Seven brands have the same six slots. Each name shows which brands have
 * it; changing one renames, adds, switches off or removes it on the brands
 * ticked, under the same rules as a brand's own slot screen.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalSlots } from "@/domain/global/estate";
import { AddName, NameTable } from "../names";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";

export const metadata = { title: "Ad slots · Petrosil" };
export const dynamic = "force-dynamic";

export default async function GlobalSlotsPage() {
  const viewer = (await currentViewer())!;
  const [brands, slots] = await Promise.all([brandsFor(viewer.siteIds), globalSlots(viewer.siteIds)]);
  const shown = brands.map(({ slug, name }) => ({ slug, name }));

  return (
    <>
      <Heading title="Ad slots" sub="The places on the brand sites an ad can run, across the brands." />

      <Panel title="Add a slot" flush={false}>
        <AddName kind="slot" brands={shown} />
      </Panel>

      <div style={{ height: 16 }} />

      <Panel title={`${count(slots.length)} slot name${slots.length === 1 ? "" : "s"}`} hint="Faded: a brand without it.">
        {slots.length ? (
          <NameTable
            kind="slot"
            brands={shown}
            rows={slots.map((slot) => ({
              title: slot.title,
              brands: slot.brands.map((brand) => ({ slug: brand.slug, name: brand.name, enabled: brand.enabled, count: brand.ads })),
            }))}
          />
        ) : (
          <Empty>No ad slots on your brands yet.</Empty>
        )}
      </Panel>
    </>
  );
}
