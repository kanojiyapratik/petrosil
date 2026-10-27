/**
 * Article categories, across the brands.
 *
 * Eight brands file articles under "AMEA Events". Each name shows which
 * brands have it; changing one renames, adds or removes it on the brands
 * ticked. A category's address never moves, and one with articles filed
 * under it is kept.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalCategories } from "@/domain/global/estate";
import { AddName, NameTable } from "../names";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";

export const metadata = { title: "Categories · Petrosil" };
export const dynamic = "force-dynamic";

export default async function GlobalCategoriesPage() {
  const viewer = (await currentViewer())!;
  const [brands, categories] = await Promise.all([brandsFor(viewer.siteIds), globalCategories(viewer.siteIds)]);
  const shown = brands.map(({ slug, name }) => ({ slug, name }));

  return (
    <>
      <Heading title="Categories" sub="How articles are filed on the brand sites, across the brands." />

      <Panel title="Add a category" flush={false}>
        <AddName kind="category" brands={shown} />
      </Panel>

      <div style={{ height: 16 }} />

      <Panel title={`${count(categories.length)} categor${categories.length === 1 ? "y" : "ies"}`} hint="Faded: a brand without it.">
        {categories.length ? (
          <NameTable
            kind="category"
            brands={shown}
            rows={categories.map((category) => ({
              title: category.name,
              brands: category.brands.map((brand) => ({ slug: brand.slug, name: brand.name, count: brand.articles })),
            }))}
          />
        ) : (
          <Empty>No categories on your brands yet.</Empty>
        )}
      </Panel>
    </>
  );
}
