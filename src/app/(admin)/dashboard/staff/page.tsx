/**
 * Who can get into this admin.
 *
 * Nine separate admins meant nine separate lists of people with access, and
 * no way to answer "who can see the whole estate". The migration deliberately
 * granted nobody: 12 accounts were admins on the old titanium dioxide site
 * alone, several of them people who have left, and importing that was not a
 * decision a script should make.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { listStaff } from "@/domain/dashboard/catalogue";
import { Empty, Heading, Panel, count, when } from "../../ui";

export const metadata = { title: "Staff · Petrosil" };
export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const viewer = (await currentViewer())!;
  const rows = await listStaff(viewer.siteIds);

  const superadmins = rows.filter((row) => row.superadmin).length;

  return (
    <>
      <Heading
        title="Staff"
        sub="A superadmin sees the whole estate. Staff see only the brands they were granted."
      />

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(rows.length)}</div>
          <div className="k">people with access</div>
        </div>
        <div className="tile">
          <div className="n">{count(superadmins)}</div>
          <div className="k">see everything</div>
        </div>
      </div>

      <Panel title="The team">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Sees</th>
              <th>Account</th>
              <th>Last signed in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/clients/${row.id}`}>
                    <strong>{row.name}</strong>
                  </Link>
                  <div className="small muted">{row.email}</div>
                </td>
                <td>
                  {row.superadmin ? (
                    <span className="badge brand">the whole estate</span>
                  ) : (
                    row.brands.map((brand) => (
                      <span key={brand.slug} className="tag" style={{ marginRight: 4 }}>
                        {brand.slug}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <span className={`badge ${row.status === "active" ? "ok" : "bad"}`}>
                    {row.status}
                  </span>
                </td>
                <td>
                  {row.last_login_at ? when(row.last_login_at) : <span className="muted">never</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>Nobody has been granted access.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <div className="note" style={{ marginTop: 16 }}>
        The nine old admins between them listed 34 accounts with a role. None of them was carried
        over — access is granted here, deliberately, one person at a time.
      </div>
    </>
  );
}
