/**
 * Article categories.
 *
 * The count is of articles actually filed under each, which is how a
 * category that nobody has used in four years becomes visible. The old
 * admins had four categories each and no count.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listCategories } from "@/domain/dashboard/catalogue";
import {
  BrandField,
  Empty,
  Filters,
  Heading,
  Panel,
  count,
  one,
  type Search,
} from "../../ui";

export const metadata = { title: "Categories · Petrosil" };
export const dynamic = "force-dynamic";

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;
  const site = one(search, "site");

  const [brands, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    listCategories(viewer.siteIds, { site }),
  ]);

  return (
    <>
      <Heading
        title="Categories"
        sub="How articles are filed on each brand site, and how much is actually filed there."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/categories">
          <BrandField brands={brands} value={site} />
        </Filters>
      </Panel>

      <Panel title={`${count(rows.length)} categor${rows.length === 1 ? "y" : "ies"}`}>
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Brand</th>
              <th className="num">Order</th>
              <th className="num">Articles</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.name}</strong>
                  <div className="small muted">/{row.slug}</div>
                </td>
                <td>{row.site_name}</td>
                <td className="num">{row.sort_order}</td>
                <td className="num">
                  {row.articles === 0 ? (
                    <span className="muted">unused</span>
                  ) : (
                    count(row.articles)
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>No categories. Articles will be filed under nothing.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
