/**
 * Newsletters: find an issue, open it, or start the next one.
 *
 * Every issue carried from the old sites is "archived": the old schema never
 * recorded whether one went out, so the screen does not pretend to know. New
 * issues start as drafts built from a template, as the old composer built
 * them.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { listNewsletters, listTemplates } from "@/domain/dashboard/promotion";
import { ComposeForm } from "./forms";
import { STATUS } from "./status";
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
  when,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Newsletters · Petrosil" };
export const dynamic = "force-dynamic";

export default async function NewslettersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;

  const status = one(search, "status");
  const q = one(search, "q");
  const page = pageParam(one(search, "page"));
  const base = `/dashboard/sites/${slug}/newsletters`;

  const [paged, templates] = await Promise.all([
    listNewsletters(viewer.siteIds, { site: slug, status, q, page }),
    listTemplates(viewer.siteIds, { site: slug }),
  ]);

  return (
    <>
      <Heading
        title="Newsletters"
        sub="Start an issue from a template, edit it, and send yourself a test. Issues from the old site are kept to read and copy."
      />

      <Panel title="New issue" flush={false}>
        <ComposeForm
          site={slug}
          templates={templates.filter((row) => row.enabled).map((row) => ({ id: row.id, title: row.title }))}
        />
      </Panel>

      <Panel flush={false}>
        <Filters action={base}>
          {status ? <input type="hidden" name="status" value={status} /> : null}
          <div className="field grow">
            <label htmlFor="q">Title contains</label>
            <input id="q" name="q" type="search" defaultValue={q ?? ""} placeholder="Singapore, Group II, May 2026…" />
          </div>
        </Filters>
      </Panel>

      <div style={{ margin: "14px 0" }}>
        <Chips
          base={base}
          param="status"
          here={{ q }}
          value={status}
          options={[
            { value: "", label: "All" },
            { value: "draft", label: "Drafts" },
            { value: "sent", label: "Sent" },
            { value: "archived", label: "From the old site" },
          ]}
        />
      </div>

      <Panel title={`${count(paged.total)} issue${paged.total === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Status</th>
              <th className="num">Reached</th>
              <th>Written</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => {
              const shown = STATUS[row.status] ?? { label: row.status, tone: "" };

              return (
                <tr key={row.id}>
                  <td>
                    <Link href={`${base}/${row.id}`}>
                      <strong>{row.title}</strong>
                    </Link>
                    {row.template ? <div className="small muted">from {row.template}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${shown.tone}`}>{shown.label}</span>
                  </td>
                  <td className="num">
                    {row.status === "sent" ? count(row.recipients) : <span className="muted">—</span>}
                  </td>
                  <td>{row.sent_at ? `sent ${when(row.sent_at)}` : when(row.created_at)}</td>
                </tr>
              );
            })}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>{q ? `No issue has "${q}" in its title.` : "No newsletters."}</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager base={base} here={{ status, q }} page={paged.page} perPage={paged.per_page} total={paged.total} />
      </Panel>
    </>
  );
}
