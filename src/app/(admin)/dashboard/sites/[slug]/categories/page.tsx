/**
 * Article categories.
 *
 * The count is of articles actually filed under each, which is how a
 * category that nobody has used in four years becomes visible. The old
 * admins had four categories each and no count.
 */

import { currentViewer } from "@/lib/auth/server";
import { listCategories } from "@/domain/dashboard/catalogue";
import { CategoryRow, NewCategory } from "./forms";
import {
  Empty,
  Heading,
  Panel,
  count,
  one,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Categories · Petrosil" };
export const dynamic = "force-dynamic";

export default async function CategoriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const site = slug;

  const rows = await listCategories(viewer.siteIds, { site });

  return (
    <>
      <Heading
        title="Categories"
        sub="How articles are filed on each brand site, and how much is actually filed there."
      />

      <Panel title="New category" flush={false}>
        <NewCategory slug={slug} />
      </Panel>

      <Panel
        title={`${count(rows.length)} categor${rows.length === 1 ? "y" : "ies"}`}
        hint="Change a name or position and press Save on its row. The address under each name does not change."
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Category</th>
              <th>Position</th>
              <th className="num">Articles</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CategoryRow key={row.id} slug={slug} row={row} />
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
