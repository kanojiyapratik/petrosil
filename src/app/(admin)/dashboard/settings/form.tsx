"use client";

/**
 * The settings form.
 *
 * A secret arrives masked and posts back masked unless somebody types over
 * it; the action drops any value still containing a bullet, so saving the
 * page without touching the SMTP password cannot blank it.
 */

import { useActionState } from "react";

import type { SettingRow } from "@/domain/dashboard/settings";
import { saveSettings } from "./actions";

type Result = { saved?: string; error?: string } | null;

export function SettingsForm({
  rows,
  site,
  canEdit,
}: {
  rows: SettingRow[];
  site: string | null;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(saveSettings, null as Result);

  const groups = [...new Set(rows.map((row) => row.group))];

  return (
    <form action={action}>
      <input type="hidden" name="site" value={site ?? ""} />

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <p className="flash" role="status">
          {state.saved}
        </p>
      ) : null}

      {groups.map((group) => (
        <div className="panel" key={group}>
          <div className="head">
            <h2>{group}</h2>
          </div>
          <div className="body">
            {rows
              .filter((row) => row.group === group)
              .map((row) => (
                <div className="field" key={row.key}>
                  <label htmlFor={row.key}>
                    {row.label}
                    {row.source === "estate" && site ? (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        from the estate
                      </span>
                    ) : null}
                    {row.source === "brand" ? (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        set for this brand
                      </span>
                    ) : null}
                  </label>

                  {row.kind === "textarea" ? (
                    <textarea
                      id={row.key}
                      name={`set:${row.key}`}
                      defaultValue={row.value}
                      disabled={!canEdit}
                    />
                  ) : (
                    <input
                      id={row.key}
                      name={`set:${row.key}`}
                      type={
                        row.kind === "email"
                          ? "email"
                          : row.kind === "number"
                            ? "text"
                            : "text"
                      }
                      inputMode={row.kind === "number" ? "numeric" : undefined}
                      defaultValue={row.value}
                      disabled={!canEdit}
                      autoComplete="off"
                    />
                  )}

                  {row.help ? <div className="small muted">{row.help}</div> : null}
                  {row.secret ? (
                    <div className="small muted">
                      {row.set
                        ? "Set. Only the last four characters are shown; type over it to replace it."
                        : "Not set."}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        </div>
      ))}

      {canEdit ? (
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : site ? "Save for this brand" : "Save estate defaults"}
        </button>
      ) : (
        <p className="note">
          Only a superadmin can change the estate defaults. Pick a brand to set an override.
        </p>
      )}
    </form>
  );
}
