/**
 * Roles.
 *
 * A role narrows what staff may do on the brands they hold it on; staff with
 * no role have full access to their brands, and a superadmin has everything.
 * Unlike the old sites, every permission here is checked where the work is
 * done. Permissions carried from the old sites that nothing checks are called
 * out rather than shown as though they did something.
 */

import { currentViewer } from "@/lib/auth/server";
import { PERMISSIONS, PERMISSION_KEYS, labelFor, listRoles } from "@/domain/dashboard/permissions";
import { RoleForm } from "./role-form";
import { Empty, Heading, Panel, count } from "../../ui";

export const metadata = { title: "Roles · Petrosil" };
export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const viewer = (await currentViewer())!;
  const rows = await listRoles(viewer.siteIds);
  const stranded = rows.flatMap((row) => row.unknown);
  const groups = PERMISSIONS.map((group) => ({ group: group.group, items: group.items }));

  return (
    <>
      <Heading
        title="Roles"
        sub="Staff with no role have full access to their brands. A role narrows that to exactly what it ticks, and it is checked whenever they save something."
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
          <div className="n">{count(stranded.length)}</div>
          <div className="k">carried permissions nothing checks</div>
        </div>
      </div>

      {viewer.isSuperadmin ? (
        <Panel title="New role" flush={false}>
          <RoleForm groups={groups} />
        </Panel>
      ) : (
        <p className="note">Only a superadmin can change roles.</p>
      )}

      {rows.map((row) => (
        <Panel
          key={row.id}
          title={row.name}
          hint={`${count(row.permissions.length)} permissions · held by ${count(row.holders)}`}
          flush={false}
        >
          {viewer.isSuperadmin ? (
            <RoleForm
              groups={groups}
              role={{
                id: row.id,
                name: row.name,
                description: row.description,
                permissions: row.permissions,
                holders: row.holders,
              }}
            />
          ) : (
            <p className="small">{row.permissions.map(labelFor).join(" · ") || "No permissions."}</p>
          )}
          {row.unknown.length > 0 ? (
            <p className="small muted" style={{ marginBottom: 0 }}>
              Carried from the old sites but checked by nothing, and dropped on the next save:{" "}
              {row.unknown.join(", ")}
            </p>
          ) : null}
        </Panel>
      ))}

      {rows.length === 0 ? (
        <Panel title="No roles">
          <Empty>No roles yet. Staff without one have full access to their brands.</Empty>
        </Panel>
      ) : null}
    </>
  );
}
