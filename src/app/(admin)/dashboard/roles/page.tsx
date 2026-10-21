/**
 * Roles.
 *
 * The permission names are the old sites' own, so a role set up in 2019
 * still means what it meant. What is new is the last column: a permission
 * saved against a role that nothing in this codebase checks is called out
 * rather than displayed as though it does something. The old estate had
 * three `product-*` permissions pointing at a feature that had been removed.
 */

import { currentViewer } from "@/lib/auth/server";
import { PERMISSIONS, PERMISSION_KEYS, labelFor, listRoles } from "@/domain/dashboard/permissions";
import { Empty, Heading, Panel, count } from "../../ui";

export const metadata = { title: "Roles · Petrosil" };
export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const viewer = (await currentViewer())!;
  const rows = await listRoles(viewer.siteIds);

  const stranded = rows.flatMap((row) => row.unknown);

  return (
    <>
      <Heading
        title="Roles"
        sub="A named set of permissions. The three built-in roles — superadmin, staff, subscriber — are what the code itself checks."
      />

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(rows.length)}</div>
          <div className="k">roles</div>
        </div>
        <div className="tile">
          <div className="n">{count(PERMISSION_KEYS.length)}</div>
          <div className="k">permissions available</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.reduce((sum, row) => sum + row.holders, 0))}</div>
          <div className="k">grants in force</div>
        </div>
      </div>

      {stranded.length > 0 ? (
        <div className="note" style={{ marginBottom: 16 }}>
          <strong>{stranded.length}</strong> saved permission
          {stranded.length === 1 ? "" : "s"} nothing checks:{" "}
          {[...new Set(stranded)].join(", ")}.
        </div>
      ) : null}

      <Panel title="Roles">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Applies to</th>
              <th className="num">Permissions</th>
              <th className="num">People holding it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.name}</strong>
                  {row.description ? (
                    <div className="small muted">{row.description}</div>
                  ) : null}
                  {row.permissions.length > 0 ? (
                    <div className="small muted">
                      {row.permissions
                        .slice(0, 6)
                        .map((permission) => labelFor(permission))
                        .join(" · ")}
                      {row.permissions.length > 6 ? ` … +${row.permissions.length - 6}` : ""}
                    </div>
                  ) : null}
                </td>
                <td>{row.site ?? <span className="muted">every brand</span>}</td>
                <td className="num">
                  {row.permissions.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    count(row.permissions.length)
                  )}
                </td>
                <td className="num">
                  {row.holders === 0 ? <span className="muted">nobody</span> : count(row.holders)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <Empty>
                    No named roles. The three built-in ones are enough until somebody needs a
                    narrower grant than &ldquo;staff&rdquo;.
                  </Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <Panel title="What a role can be given" hint={`${count(PERMISSION_KEYS.length)} permissions`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Area</th>
              <th>Permissions</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((group) => (
              <tr key={group.group}>
                <td>
                  <strong>{group.group}</strong>
                </td>
                <td>
                  {group.items.map((item) => (
                    <span key={item.key} className="tag" style={{ marginRight: 4 }}>
                      {item.key}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
