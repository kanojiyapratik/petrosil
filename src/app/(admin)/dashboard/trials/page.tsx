/**
 * Free trials waiting on a decision.
 *
 * Approving one grants the brand a trial membership that runs out on its own
 * — the nightly sweep sees to that — which is why the old habit of giving
 * someone "a trial" and forgetting is not possible here.
 */

import { currentViewer } from "@/lib/auth/server";
import { listTrials } from "@/domain/billing/trials";
import { decide } from "../actions";
import { Chips, Empty, Heading, Panel, count, one, when, type Search } from "../../ui";
import { PeopleNav } from "@/app/(admin)/people-nav";

export const metadata = { title: "Trial requests · Petrosil" };
export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "declined"] as const;

const TONE: Record<string, string> = {
  pending: "warn",
  approved: "ok",
  declined: "bad",
};

export default async function TrialsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;
  const status = one(search, "status");

  const [all, rows] = await Promise.all([
    listTrials(viewer.siteIds, undefined),
    listTrials(viewer.siteIds, status),
  ]);

  return (
    <>
      <PeopleNav />

      <Heading
        title="Trial requests"
        sub="Requests from the brand sites. An approved trial expires by itself; nobody has to remember it."
      />

      <div style={{ margin: "0 0 14px" }}>
        <Chips
          base="/dashboard/trials"
          param="status"
          here={{}}
          value={status}
          options={[
            { value: "", label: "All", n: all.length },
            ...STATUSES.map((value) => ({
              value,
              label: value,
              n: all.filter((row) => row.status === value).length,
            })),
          ]}
        />
      </div>

      <Panel title={`${count(rows.length)} request${rows.length === 1 ? "" : "s"}`}>
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Brand</th>
              <th>Asked</th>
              <th>Status</th>
              <th>Decide</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.name}</strong>
                  <div className="small muted">
                    {row.email}
                    {row.company ? ` · ${row.company}` : ""}
                  </div>
                  {row.note ? <div className="small muted">&ldquo;{row.note}&rdquo;</div> : null}
                </td>
                <td>{row.site}</td>
                <td>
                  {when(row.created_at)}
                  {row.decided_at ? (
                    <div className="small muted">decided {when(row.decided_at)}</div>
                  ) : null}
                </td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>{row.status}</span>
                  {row.status === "approved" ? (
                    <div className="small muted">{row.days} days</div>
                  ) : null}
                </td>
                <td>
                  {row.status === "pending" ? (
                    <div className="actions">
                      <form action={decide}>
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="decision" value="approve" />
                        <input
                          type="hidden"
                          name="days"
                          value={row.days > 0 ? row.days : 14}
                        />
                        <button className="small" type="submit">
                          Approve
                        </button>
                      </form>
                      <form action={decide}>
                        <input type="hidden" name="id" value={row.id} />
                        <input type="hidden" name="decision" value="decline" />
                        <button className="ghost small" type="submit">
                          Decline
                        </button>
                      </form>
                    </div>
                  ) : (
                    <span className="muted">done</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>Nothing waiting.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
