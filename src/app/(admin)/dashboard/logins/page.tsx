/**
 * The sign-in log.
 *
 * Refusals carry their reason, which is the difference between "they typed
 * it wrong" and "somebody is working through a password list". The old
 * `loginlogs` table recorded only successes, so the second case was
 * invisible.
 */

import { currentViewer } from "@/lib/auth/server";
import { loginLog } from "@/domain/dashboard/activity";
import { Chips, Empty, Heading, Panel, count, one, when, type Search } from "../../ui";
import { PeopleNav } from "@/app/(admin)/people-nav";

export const metadata = { title: "Sign-ins · Petrosil" };
export const dynamic = "force-dynamic";

export default async function LoginsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;
  const only = one(search, "only");

  const rows = await loginLog(viewer.siteIds, {
    onlyFailures: only === "failures",
    limit: 200,
  });

  return (
    <>
      <PeopleNav />

      <Heading
        title="Sign-ins"
        sub="Every attempt, successful or not, with the reason it was refused."
      />

      <div style={{ margin: "0 0 14px" }}>
        <Chips
          base="/dashboard/logins"
          param="only"
          here={{}}
          value={only}
          // No counts on these: the screen holds the newest 200 and a count
          // taken from them would say "200" however many there are.
          options={[
            { value: "", label: "Everything" },
            { value: "failures", label: "Refused only" },
          ]}
        />
      </div>

      <Panel title={`${count(rows.length)} attempt${rows.length === 1 ? "" : "s"}`} hint="Newest first, 200 shown.">
        <table className="tight">
          <thead>
            <tr>
              <th>When</th>
              <th>Email</th>
              <th>Account</th>
              <th>From</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{when(row.at)}</td>
                <td>{row.email}</td>
                <td>{row.who ?? <span className="muted">no such account</span>}</td>
                <td>{row.ip ?? <span className="muted">unknown</span>}</td>
                <td>
                  <span className={`badge ${row.ok ? "ok" : "bad"}`}>
                    {row.ok ? "signed in" : "refused"}
                  </span>
                  {row.reason ? <div className="small muted">{row.reason}</div> : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>Nothing logged yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
