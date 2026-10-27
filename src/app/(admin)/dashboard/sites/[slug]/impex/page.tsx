/**
 * Impex data — the import/export sheets the brands publish, 1,167 on baseoil.
 *
 * The same shape as reports, kept as its own screen because the old admin
 * had it as its own screen and the people using it think of the two as
 * different things.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listImpex } from "@/domain/dashboard/publishing";
import {
  Empty,
  Heading,
  ListBar,
  Pager,
  Panel,
  count,
  one,
  pageParam,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Impex data · Petrosil" };
export const dynamic = "force-dynamic";

export default async function ImpexPage({
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
  const q = one(search, "q");
  const page = pageParam(one(search, "page"));

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listImpex(viewer.siteIds, { site, search: q, page }),
  ]);

  return (
    <>
      <Heading
        title="Impex data"
        sub="Import and export sheets, published per period."
      >
        <Link className="button small" href={`/dashboard/sites/${slug}/impex/new`}>
          New sheet
        </Link>
      </Heading>

      <ListBar action={`/dashboard/sites/${slug}/impex`} q={q} placeholder="Search: title" />

      <Panel title={`${count(paged.total)} sheet${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Title</th>
              <th>Brand</th>
              <th>Dated</th>
              <th>Who can read it</th>
              <th className="num">Opened</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/impex/${row.id}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  <div className="small muted">
                    {row.file ? <code>{row.file}</code> : "no file attached"}
                  </div>
                </td>
                <td>{row.site}</td>
                <td>{row.authored_on ?? <span className="muted">undated</span>}</td>
                <td>
                  <span className={`badge ${row.status === "published" ? "ok" : "brand"}`}>
                    {row.status === "premium" ? "subscribers" : row.status}
                  </span>
                </td>
                <td className="num">{count(row.clicks)}</td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No impex sheets.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base={`/dashboard/sites/${slug}/impex`}
          here={{ site, q }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
