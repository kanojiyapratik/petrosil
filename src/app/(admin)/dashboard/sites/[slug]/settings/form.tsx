"use client";

/**
 * The settings form, shared by Site defaults and each brand's Settings tab.
 *
 * Laid out the way settings pages usually are: each group is a section with
 * its name and a line about what it is on the left, and its fields in two
 * columns on the right. It used to be one long column of full-width boxes,
 * every multi-line field a tall empty textarea, which the owner rightly
 * called weird. Long fields (lists of addresses, the description) span both
 * columns; empty fields say so in their placeholder, so a blank page reads
 * as "nothing set yet" rather than as broken. Save stays in view at the
 * bottom of the screen however far down you are.
 *
 * A secret arrives masked and posts back masked unless somebody types over
 * it; the action drops any value still containing a bullet, so saving the
 * page without touching the SMTP password cannot blank it.
 */

import { useActionState } from "react";

import type { SettingRow } from "@/domain/dashboard/settings";
import { saveSettings } from "./actions";

type Result = { saved?: string; error?: string } | null;

/** What each group is for, in a line. */
const ABOUT: Record<string, string> = {
  Brand: "The name, description and contact addresses the site shows.",
  Mail: "Who the site's emails come from, and the server that sends them.",
  Notifications: "Who is told when a report goes out or an offer comes in.",
  Integrations: "Keys and lists for the outside services the site uses.",
  Behaviour: "How the brand site lists things and how long a trial lasts.",
};

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
  // On a brand's tab an empty box falls back to the estate's value.
  const empty = site ? "Uses the estate default" : "Not set";

  return (
    <form action={action} className="settings">
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
        <section className="settings-group" key={group}>
          <div className="settings-about">
            <h2>{group}</h2>
            {ABOUT[group] ? <p>{ABOUT[group]}</p> : null}
          </div>

          <div className="settings-fields">
            {rows
              .filter((row) => row.group === group)
              .map((row) => (
                <div className={row.kind === "textarea" ? "settings-field wide" : "settings-field"} key={row.key}>
                  <label htmlFor={row.key}>
                    {row.label}
                    {row.source === "estate" && site ? <span className="tag">from the estate</span> : null}
                    {row.source === "brand" ? <span className="tag on">set for this brand</span> : null}
                  </label>

                  {row.kind === "textarea" ? (
                    <textarea
                      id={row.key}
                      name={`set:${row.key}`}
                      defaultValue={row.value}
                      disabled={!canEdit}
                      rows={3}
                      placeholder={empty}
                    />
                  ) : (
                    <input
                      id={row.key}
                      name={`set:${row.key}`}
                      type={row.kind === "email" ? "email" : "text"}
                      inputMode={row.kind === "number" ? "numeric" : undefined}
                      defaultValue={row.value}
                      disabled={!canEdit}
                      autoComplete="off"
                      spellCheck={row.kind === "secret" ? false : undefined}
                      placeholder={row.secret && !row.set ? "Not set" : empty}
                    />
                  )}

                  {row.help ? <p className="settings-help">{row.help}</p> : null}
                  {row.secret && row.set ? (
                    <p className="settings-help">Only the last four characters are shown; type over it to replace it.</p>
                  ) : null}
                </div>
              ))}
          </div>
        </section>
      ))}

      {canEdit ? (
        <div className="settings-save">
          <span className="settings-save-note">
            {site ? "Changes apply to this brand only." : "Changes apply to every brand that has not set its own value."}
          </span>
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : site ? "Save for this brand" : "Save site defaults"}
          </button>
        </div>
      ) : (
        <p className="note">Only a superadmin can change the estate defaults. Pick a brand to set an override.</p>
      )}
    </form>
  );
}
