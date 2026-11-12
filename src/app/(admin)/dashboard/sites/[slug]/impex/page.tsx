/**
 * Impex data — the import/export sheets the brands publish, 1,167 on baseoil.
 *
 * The same shape as reports, kept as its own screen because the old admin
 * had it as its own screen and the people using it think of the two as
 * different things.
 */

import Link from "@/lib/ui/link";

import { currentViewer } from "@/lib/auth/server";
import { RestoreButton, ViewOnSite } from "@/app/(admin)/content-row";
import { restoreImpexAction } from "./actions";
import { brandsFor } from "@/domain/dashboard/brands";
import { listImpex } from "@/domain/dashboard/publishing";
import {
  Chips,
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

export const metadata = { title: "Impex sheets · Petrosil" };
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
  const status = one(search, "status");
  const deleted = status === "deleted";
  const refused = one(search, "refused");

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listImpex(viewer.siteIds, { site, status, search: q, page }),
  ]);

  return (
    <>
      <Heading
        title="Impex sheets"
        sub="Import and export sheets, published per period."
      >
        <Link className="button small" href={`/dashboard/sites/${slug}/impex/new`}>
          New sheet
        </Link>
      </Heading>

      <ListBar action={`/dashboard/sites/${slug}/impex`} q={q} placeholder="Search: title" keep={{ status }}>
        <Chips
          base={`/dashboard/sites/${slug}/impex`}
          param="status"
          here={{ site, q }}
          value={status}
          options={[
            { value: "", label: "All" },
            { value: "published", label: "Open to everyone" },
            { value: "premium", label: "Subscribers only" },
            { value: "draft", label: "Draft" },
            { value: "deleted", label: "Deleted" },
          ]}
        />
      </ListBar>

      {deleted ? (
        <p className="note">Deleted sheets are hidden from the site and the list, not destroyed. Restore brings one back as it was.</p>
      ) : null}
      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}



      <Panel title={`${count(paged.total)} sheet${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Title</th>
              <th>Dated</th>
              <th>Who can read it</th>
              <th className="num">Opened</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {deleted ? (
                    <strong>{row.title}</strong>
                  ) : (
                    <Link href={`/dashboard/sites/${slug}/impex/${row.id}`}>
                      <strong>{row.title}</strong>
                    </Link>
                  )}
                  <div className="small muted">
                    {row.file ? <code>{row.file}</code> : "no file attached"}
                  </div>
                  {deleted ? (
                    <RestoreButton action={restoreImpexAction} id={row.id} site={slug} />
                  ) : row.status !== "draft" ? (
                    <ViewOnSite href={`/${slug}/impex/${encodeURIComponent(row.slug)}`} />
                  ) : null}
                </td>
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
                <td colSpan={4}>
                  <Empty>No impex sheets.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base={`/dashboard/sites/${slug}/impex`}
          here={{ site, status, q }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
