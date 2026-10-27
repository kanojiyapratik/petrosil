/**
 * Enquiries: what members wrote to companies, to offers and about plans.
 *
 * New ones first in staff's mind, so the page opens on "new" whenever there
 * are any. The thousands carried from the old sites are "old site": readable,
 * searchable, and not pretending anyone answered them, because nothing ever
 * recorded that.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { listEnquiries } from "@/domain/enquiries/inbox";
import { KIND, STATUS } from "./labels";
import { Chips, Empty, Heading, ListBar, Pager, Panel, Tile, count, one, pageParam, when, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Enquiries · Petrosil" };
export const dynamic = "force-dynamic";

export default async function EnquiriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const base = `/dashboard/sites/${slug}/enquiries`;

  const kind = one(search, "kind");
  const q = one(search, "q");
  const page = pageParam(one(search, "page"));
  // "all" is an explicit choice; no choice at all means "new".
  const status = one(search, "status") ?? "new";

  const paged = await listEnquiries(viewer, slug, {
    kind,
    q,
    page,
    status: status === "all" ? undefined : status,
  });

  return (
    <>
      <Heading
        title="Enquiries"
        sub="Members writing to a company in the directory, replying to an offer, or asking about a plan. Reply from your mailbox, then mark it handled."
      />

      <div className="tiles">
        <Tile n={paged.counts.new} k="waiting for someone" />
        <Tile n={paged.counts.handled} k="handled" />
        <Tile n={paged.counts.archived} k="from the old site" />
      </div>

      <ListBar action={base} q={q} placeholder="Search: name, company, email, message" keep={{ status, kind }}>
        <Chips
          base={base}
          param="status"
          here={{ kind, q }}
          value={status}
          options={[
            { value: "new", label: "New" },
            { value: "handled", label: "Handled" },
            { value: "archived", label: "From the old site" },
            { value: "all", label: "All" },
          ]}
        />
        <Chips
          base={base}
          param="kind"
          here={{ status, q }}
          value={kind}
          options={[
            { value: "", label: "Every kind" },
            { value: "company", label: KIND.company! },
            { value: "offer", label: KIND.offer! },
            { value: "plan", label: KIND.plan! },
          ]}
        />
      </ListBar>

      <Panel title={`${count(paged.total)} enquir${paged.total === 1 ? "y" : "ies"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>From</th>
              <th>About</th>
              <th>Message</th>
              <th>Status</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((row) => {
              const shown = STATUS[row.status] ?? { label: row.status, tone: "" };

              return (
                <tr key={row.id}>
                  <td>
                    {row.fromName || row.fromEmail ? (
                      <>
                        <strong>{row.fromName ?? row.fromEmail}</strong>
                        {row.fromCompany ? <div className="small muted">{row.fromCompany}</div> : null}
                      </>
                    ) : (
                      <span className="muted">not recorded</span>
                    )}
                  </td>
                  <td>
                    <div className="small muted">{KIND[row.kind] ?? row.kind}</div>
                    {row.about ?? <span className="muted">—</span>}
                  </td>
                  <td>
                    <Link href={`${base}/${row.id}`}>
                      {row.subject ? <strong>{row.subject}: </strong> : null}
                      {row.message.length > 140 ? `${row.message.slice(0, 140)}…` : row.message || "(no text)"}
                    </Link>
                  </td>
                  <td>
                    <span className={`badge ${shown.tone}`}>{shown.label}</span>
                  </td>
                  <td>{when(row.createdAt.toISOString())}</td>
                </tr>
              );
            })}
            {paged.rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>
                    {status === "new" && !q && !kind
                      ? "Nothing waiting. New enquiries from the site appear here."
                      : "No enquiries match."}
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager base={base} here={{ status, kind, q }} page={paged.page} perPage={paged.per_page} total={paged.total} />
      </Panel>
    </>
  );
}
