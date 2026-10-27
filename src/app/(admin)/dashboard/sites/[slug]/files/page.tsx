/**
 * Files.
 *
 * The old sites had a PHP file browser over a directory, so what was in it
 * was whatever happened to be on disk. Here every file is a row with its
 * folder, its size and who put it there; carried files keep the old folders,
 * so a report that names "584.pdf" still finds it.
 *
 * Also said plainly: how many files content names that are not here. On the
 * old sites that was invisible until a reader clicked a dead link.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { db } from "@/db";
import { listMedia } from "@/domain/dashboard/masters";
import { missingReferences } from "@/domain/files/import";
import { FOLDERS, isPublicFolder } from "@/domain/files/folders";
import { MAX_UPLOAD_BYTES } from "@/domain/files/access";
import { brandsFor } from "@/domain/dashboard/brands";
import { Chips, Empty, Heading, ListBar, Pager, Panel, count, one, pageParam, when, type Search } from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Files · Petrosil" };
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
  const base = `/dashboard/sites/${slug}/files`;

  const folder = one(search, "folder");
  const q = one(search, "q");
  const page = pageParam(one(search, "page"));
  const uploaded = one(search, "uploaded");
  const error = one(search, "error");

  const brand = (await brandsFor(viewer.siteIds)).find((row) => row.slug === slug);
  const [paged, missing] = await Promise.all([
    listMedia(viewer.siteIds, { site: slug, folder, q, page }),
    brand ? missingReferences(db(), brand.id) : Promise.resolve([] as string[]),
  ]);

  return (
    <>
      <Heading
        title="Files"
        sub="Report PDFs, trade sheets, article and ad images. Pictures in public folders are served to the site; PDFs and attachments only to staff."
      >
        <Popup label="Upload a file" title="Upload a file">
          <form action="/api/dashboard/files" method="post" encType="multipart/form-data">
            <input type="hidden" name="site" value={slug} />
            <div className="field">
              <label htmlFor="folder-up">Folder</label>
              <select id="folder-up" name="folder" defaultValue={folder ?? "reports/files"}>
                {FOLDERS.map((name) => (
                  <option key={name} value={name}>
                    {name} {isPublicFolder(name) ? "(public)" : "(staff only)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="file">File</label>
              <input id="file" name="file" type="file" required />
            </div>
            <div className="actions">
              <button type="submit">Upload</button>
              <span className="small muted">
                PDF, images, video, Office and CSV, up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB, renamed so it cannot clash.
              </span>
            </div>
          </form>
        </Popup>
      </Heading>

      {uploaded ? (
        <p className="flash" role="status">
          Uploaded as <code>{uploaded}</code>.
        </p>
      ) : null}
      {error ? (
        <p className="flash bad" role="alert">
          {error}
        </p>
      ) : null}

      {missing.length > 0 ? (
        <Panel title={`${count(missing.length)} file${missing.length === 1 ? "" : "s"} named by content but not here`} flush={false}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Reports, articles, offers or ads point at these names and there is no such file. Either the old site
            never had it, or it has not been carried yet.
          </p>
          <p className="small">
            {missing.slice(0, 12).map((path) => (
              <code key={path} style={{ marginRight: 8 }}>
                {path}
              </code>
            ))}
            {missing.length > 12 ? <span className="muted">and {count(missing.length - 12)} more</span> : null}
          </p>
        </Panel>
      ) : null}

      <ListBar action={base} q={q} placeholder="Search: file name" keep={{ folder }}>
        <Chips
          base={base}
          param="folder"
          here={{ q }}
          value={folder}
          options={[{ value: "", label: "Every folder" }, ...FOLDERS.map((name) => ({ value: name, label: name }))]}
        />
      </ListBar>

      <Panel title={`${count(paged.total)} file${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>File</th>
              <th>Folder</th>
              <th className="num">Size</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/api/dashboard/files/${row.id}`} target="_blank" rel="noopener">
                    <strong>{row.name}</strong>
                  </Link>
                  <div className="small muted">{row.kind}</div>
                </td>
                <td>
                  {row.folder || <span className="muted">—</span>}{" "}
                  {row.folder ? (
                    <span className={`badge ${isPublicFolder(row.folder) ? "ok" : ""}`}>
                      {isPublicFolder(row.folder) ? "public" : "staff only"}
                    </span>
                  ) : null}
                </td>
                <td className="num">{size(row.bytes)}</td>
                <td>
                  {when(row.created_at)}
                  <div className="small muted">{row.uploaded_by ?? "carried from the old site"}</div>
                </td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>
                    {q || folder
                      ? "No files match."
                      : "No files here yet. Carry the old site's with npm run import:files, or upload one above."}
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager base={base} here={{ folder, q }} page={paged.page} perPage={paged.per_page} total={paged.total} />
      </Panel>
    </>
  );
}
