/**
 * Newsletters.
 *
 * 415 of them on baseoil, and the old `sent_emails` table had six rows — so
 * "did the 14 March issue go out, and to how many people" could not be
 * answered. `sentAt` and `recipients` are new columns for exactly that, and
 * an issue that was written but never sent says so.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listNewsletters } from "@/domain/dashboard/promotion";
import {
  BrandField,
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
} from "../../ui";

export const metadata = { title: "Newsletters · Petrosil" };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  sent: "ok",
  scheduled: "warn",
  draft: "",
};

export default async function NewslettersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const status = one(search, "status");
  const page = pageParam(one(search, "page"));

  const [brands, paged] = await Promise.all([
    brandsFor(viewer.siteIds),
    listNewsletters(viewer.siteIds, { site, status, page }),
  ]);

  const reached = paged.rows.reduce((sum, row) => sum + row.recipients, 0);

  return (
    <>
      <Heading
        title="Newsletters"
        sub="What was written, whether it went out, and how many it reached."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/newsletters">
          <BrandField brands={brands} value={site} />
          {status ? <input type="hidden" name="status" value={status} /> : null}
        </Filters>
      </Panel>

      <div style={{ margin: "14px 0" }}>
        <Chips
          base="/dashboard/newsletters"
          param="status"
          here={{ site }}
          value={status}
          options={[
            { value: "", label: "All" },
            { value: "sent", label: "Sent" },
            { value: "scheduled", label: "Scheduled" },
            { value: "draft", label: "Draft" },
          ]}
        />
      </div>

      <Panel
        title={`${count(paged.total)} issue${paged.total === 1 ? "" : "s"}`}
        hint={`${count(reached)} deliveries on this page`}
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Brand</th>
              <th>Template</th>
              <th>Status</th>
              <th className="num">Reached</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.title}</strong>
                </td>
                <td>{row.site}</td>
                <td>{row.template ?? <span className="muted">none</span>}</td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>{row.status}</span>
                </td>
                <td className="num">
                  {row.status === "sent" ? count(row.recipients) : <span className="muted">—</span>}
                </td>
                <td>
                  {row.sent_at
                    ? when(row.sent_at)
                    : row.scheduled_for
                      ? `for ${when(row.scheduled_for)}`
                      : when(row.created_at)}
                </td>
              </tr>
            ))}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>No newsletters.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base="/dashboard/newsletters"
          here={{ site, status }}
          page={paged.page}
          perPage={paged.per_page}
          total={paged.total}
        />
      </Panel>
    </>
  );
}
