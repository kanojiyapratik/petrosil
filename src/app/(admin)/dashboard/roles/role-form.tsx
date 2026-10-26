"use client";

/** One role: its name and the permissions it grants, ticked by group. */

import { useActionState } from "react";

import { deleteRoleAction, saveRoleAction, type RoleResult } from "./actions";

type Group = { group: string; items: { key: string; label: string }[] };

function Flash({ state }: { state: RoleResult }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  return state?.saved ? (
    <p className="flash" role="status">
      {state.saved}
    </p>
  ) : null;
}

export function RoleForm(props: {
  groups: Group[];
  role?: { id: number; name: string; description: string | null; permissions: string[]; holders: number };
}) {
  const [state, action, pending] = useActionState(saveRoleAction, null as RoleResult);
  const [deleted, remove, removing] = useActionState(deleteRoleAction, null as RoleResult);
  const granted = new Set(props.role?.permissions ?? []);
  const key = props.role?.id ?? "new";

  return (
    <>
      <form action={action}>
        {props.role ? <input type="hidden" name="id" value={props.role.id} /> : null}
        <Flash state={state} />

        <div className="bar">
          <div className="field grow">
            <label htmlFor={`name-${key}`}>Name</label>
            <input id={`name-${key}`} name="name" type="text" maxLength={96} defaultValue={props.role?.name ?? ""} required />
          </div>
          <div className="field grow">
            <label htmlFor={`desc-${key}`}>What it is for</label>
            <input id={`desc-${key}`} name="description" type="text" defaultValue={props.role?.description ?? ""} />
          </div>
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : props.role ? "Save" : "Create role"}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "8px 16px", marginTop: 8 }}>
          {props.groups.map((group) => (
            <fieldset key={group.group} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small" style={{ fontWeight: 600 }}>
                {group.group}
              </legend>
              {group.items.map((item) => (
                <label key={item.key} className="small" style={{ display: "block" }}>
                  <input type="checkbox" name="permission" value={item.key} defaultChecked={granted.has(item.key)} />{" "}
                  {item.label}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </form>

      {props.role ? (
        <form action={remove} style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={props.role.id} />
          <Flash state={deleted} />
          <button type="submit" className="ghost small" disabled={removing || props.role.holders > 0}>
            {props.role.holders > 0 ? `Held by ${props.role.holders}, so it cannot be deleted` : "Delete this role"}
          </button>
        </form>
      ) : null}
    </>
  );
}
