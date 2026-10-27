/**
 * Reports — the PDFs the brands publish, 584 on baseoil alone.
 *
 * `status` is the paywall: a premium report shows its title and description
 * to everyone and the file to subscribers. The clicks column is what says
 * which of 584 reports anyone actually opened.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listReports } from "@/domain/dashboard/publishing";
import {
  Chips,
  Empty,
  Filters,
  Heading,
  Pager,
  Panel,
  count,
  one,
  pageParam,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Reports · Petrosil" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  published: "ok",
  premium: "brand",
  draft: "warn",
};

export default async function ReportsPage({
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
  const status = one(search, "status");
  const q = one(search, "q");
  const page = pageParam(one(search, "page"));

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listReports(viewer.siteIds, { site, status, search: q, page }),
  ]);

  return (
    <>
      <Heading
        title="Reports"
        sub="The documents a brand sells or gives away. A premium report shows its description to everyone and its file to subscribers."
      >
        <Link className="button small" href={`/dashboard/sites/${slug}/reports/new`}>
          New report
        </Link>
      </Heading>

      <Panel flush={false}>
        <Filters action={`/dashboard/sites/${slug}/reports`}>
          <div className="field grow">
            <label htmlFor="q">Search</label>
            <input id="q" name="q" type="search" defaultValue={q ?? ""} placeholder="Title" />
          </div>
          {status ? <input type="hidden" name="status" value={status} /> : null}
        </Filters>
      </Panel>

      <div style={{ margin: "14px 0" }}>
        <Chips
          base={`/dashboard/sites/${slug}/reports`}
          param="status"
          here={{ site, q }}
          value={status}
          options={[
            { value: "", label: "All" },
            { value: "published", label: "Open to everyone" },
            { value: "premium", label: "Subscribers only" },
            { value: "draft", label: "Draft" },
          ]}
        />
      </div>

      <Panel title={`${count(paged.total)} report${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Title</th>
              <th>Brand</th>
              <th>Kind</th>
              <th>Dated</th>
              <th>Who can read it</th>
              <th className="num">Opened</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/reports/${row.id}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  <div className="small muted">
                    {row.file ? <code>{row.file}</code> : "no file attached"}
                  </div>
                  {row.file ? (
                    <Link className="small" href={`/dashboard/sites/${slug}/reports/${row.id}/send`}>
                      Send to paying readers →
                    </Link>
                  ) : null}
                </td>
                <td>{row.site}</td>
                <td>
                  <span className="tag">{row.report_type}</span>
                </td>
                <td>{row.authored_on ?? <span className="muted">undated</span>}</td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>
                    {row.status === "premium" ? "subscribers" : row.status}
                  </span>
                </td>
                <td className="num">{count(row.clicks)}</td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>No reports match those filters.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base={`/dashboard/sites/${slug}/reports`}
          here={{ site, status, q }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
