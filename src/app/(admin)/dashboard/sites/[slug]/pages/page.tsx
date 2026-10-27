/**
 * Content pages — about, methodology, advertise, terms.
 *
 * Fourteen per brand in the dumps, which is 126 across the estate and the
 * reason this is one screen rather than nine: the same "Advertise with us"
 * page is maintained nine times today, and whether they agree with each
 * other is something nobody can currently see.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { staffPages } from "@/domain/dashboard/catalogue";
import {
  Empty,
  Heading,
  Panel,
  count,
  one,
  when,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Pages · Petrosil" };
export const dynamic = "force-dynamic";

export default async function PagesPage({
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

  const [brands, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    staffPages(viewer.siteIds, { site }),
  ]);

  // Which slugs exist on more than one brand, so the ones maintained nine
  // times over are visible as such.
  const shared = new Map<string, number>();

  for (const row of rows) {
    shared.set(row.slug, (shared.get(row.slug) ?? 0) + 1);
  }

  return (
    <>
      <Heading
        title="Pages"
        sub="The pages staff edit rather than deploy. A slug that appears on several brands is maintained several times."
      >
        <Link className="button small" href={`/dashboard/sites/${slug}/pages/new`}>
          New page
        </Link>
      </Heading>

      <Panel title={`${count(rows.length)} page${rows.length === 1 ? "" : "s"}`}>
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Brand</th>
              <th className="num">Words</th>
              <th>Shown</th>
              <th>Last edited</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/pages/${row.id}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  <div className="small muted">/{row.slug}</div>
                </td>
                <td>
                  {row.site_name}
                  {(shared.get(row.slug) ?? 0) > 1 ? (
                    <div className="small muted">
                      also on {(shared.get(row.slug) ?? 1) - 1} other brand
                      {(shared.get(row.slug) ?? 1) - 1 === 1 ? "" : "s"}
                    </div>
                  ) : null}
                </td>
                <td className="num">{count(row.words)}</td>
                <td>
                  <span className={`badge ${row.visible ? "ok" : ""}`}>
                    {row.visible ? "live" : "hidden"}
                  </span>
                </td>
                <td>{when(row.updated_at)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No content pages carried over yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
