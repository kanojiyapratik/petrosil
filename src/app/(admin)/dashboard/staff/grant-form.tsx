"use client";

/**
 * Giving someone access: who, which brands, and a role (or none, for full
 * access to those brands). For someone new, the set-password link comes back
 * here once, to pass on by hand while mail cannot leave the machine.
 */

import { useActionState } from "react";

import { grantAction, type StaffResult } from "./actions";

export function GrantForm(props: { brands: { slug: string; name: string }[]; roles: { id: number; name: string }[] }) {
  const [state, action, pending] = useActionState(grantAction, null as StaffResult);

  return (
    <form action={action}>
      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <div className="flash" role="status">
          {state.saved}
          {state.inviteUrl ? (
            <div style={{ marginTop: 6 }}>
              <code style={{ wordBreak: "break-all" }}>{state.inviteUrl}</code>
              <div className="small muted">Shown once. It works once and lasts a week.</div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="bar">
        <div className="field grow">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div className="field grow">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" type="text" maxLength={191} />
        </div>
        <div className="field">
          <label htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue="">
            <option value="">Full access to those brands</option>
            {props.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: ".5rem 0 0" }}>
        <legend className="small muted">Brands</legend>
        {props.brands.map((brand) => (
          <label key={brand.slug} style={{ marginRight: 14, whiteSpace: "nowrap" }}>
            <input type="checkbox" name="site" value={brand.slug} /> {brand.name}
          </label>
        ))}
      </fieldset>

      <div className="bar" style={{ marginTop: ".6rem" }}>
        <button type="submit" disabled={pending}>
          {pending ? "Granting…" : "Grant access"}
        </button>
      </div>
    </form>
  );
}
