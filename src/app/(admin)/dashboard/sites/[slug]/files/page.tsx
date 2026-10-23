/**
 * File manager.
 *
 * The old sites had a PHP file browser over a directory, so what was in it
 * was whatever happened to be on disk — including a great deal nobody could
 * attribute. Here every file is a row with who put it there and how big it
 * is, and the browser is a list rather than a filesystem.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listMedia } from "@/domain/dashboard/masters";
import {
  Empty,
  Filters,
  Heading,
  Pager,
  Panel,
  count,
  one,
  pageParam,
  when,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "File manager · Petrosil" };
export const dynamic = "force-dynamic";

/** Bytes, in the unit a person would say out loud. */
function size(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function FilesPage({
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
  const kind = one(search, "kind");
  const page = pageParam(one(search, "page"));

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listMedia(viewer.siteIds, { site, kind, page }),
  ]);

  const held = paged.rows.reduce((sum, row) => sum + row.bytes, 0);

  return (
    <>
      <Heading
        title="File manager"
        sub="Everything uploaded, with who uploaded it. Reports, ad images and article heroes all land here."
      />

      <Panel flush={false}>
        <Filters action={`/dashboard/sites/${slug}/files`}>
          <div className="field">
            <label htmlFor="kind">Type</label>
            <input id="kind" name="kind" type="search" defaultValue={kind ?? ""} placeholder="application/pdf" />
          </div>
        </Filters>
      </Panel>

      <Panel
        title={`${count(paged.total)} file${paged.total === 1 ? "" : "s"}`}
        hint={`${size(held)} on this page`}
      >
        <table className="tight">
          <thead>
            <tr>
              <th>File</th>
              <th>Brand</th>
              <th>Type</th>
              <th className="num">Size</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.name}</strong>
                  <div className="small muted">
                    <code>{row.path}</code>
                  </div>
                </td>
                <td>{row.site ?? <span className="muted">estate</span>}</td>
                <td>
                  <span className="tag">{row.kind}</span>
                </td>
                <td className="num">{size(row.bytes)}</td>
                <td>
                  {when(row.created_at)}
                  <div className="small muted">{row.uploaded_by ?? "unknown"}</div>
                </td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>
                    Nothing indexed yet. Files referenced by reports and offers that came from the
                    old sites still live on those sites&rsquo; disks.
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base={`/dashboard/sites/${slug}/files`}
          here={{ site, kind }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
