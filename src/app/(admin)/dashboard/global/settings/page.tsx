/**
 * Site defaults — the values every brand follows unless it sets its own.
 *
 * These used to open first on each brand's own Settings tab, beside chips
 * for all nine brands: standing in Base Oil Report, you were editing the
 * estate, one click from editing Bitumart. A brand's tab now edits that
 * brand alone, and the estate's defaults live here with the rest of what the
 * brands share.
 *
 * Keys found in the database that the catalogue does not know are not
 * presented as settings: 621 rows came across and a good number of them are
 * read by nothing. They used to fill the bottom of this page as an 88-row
 * table; now a button in the heading opens them in a popup, for the rare
 * time someone needs to look.
 */

import { currentViewer } from "@/lib/auth/server";
import { settingsFor, strandedSettings } from "@/domain/dashboard/settings";
import { SettingsForm } from "../../sites/[slug]/settings/form";
import { Heading, count } from "../../../ui";
import { Popup } from "../../../popup";

export const metadata = { title: "Site defaults · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SiteDefaultsPage() {
  const viewer = (await currentViewer())!;
  const [rows, stranded] = await Promise.all([settingsFor(viewer.siteIds), strandedSettings(viewer.siteIds)]);

  return (
    <>
      <Heading
        title="Site defaults"
        sub={
          viewer.isSuperadmin
            ? "What every brand uses unless it sets its own value on its Settings tab."
            : "What every brand uses unless it sets its own value. Only a superadmin can change these."
        }
      >
        {stranded.length > 0 ? (
          <Popup ghost label={`Old unused keys (${count(stranded.length)})`} title="Carried over from the old sites, read by nothing">
            <p className="small muted" style={{ marginTop: 0 }}>
              These came across from the nine old admins. Nothing on the platform reads them, so changing them would do
              nothing; they are kept only so nothing is lost.
            </p>
            <div className="popup-scroll">
              <table className="tight">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Brand</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {stranded.map((row) => (
                    <tr key={`${row.site ?? "estate"}-${row.key}`}>
                      <td>
                        <code>{row.key}</code>
                      </td>
                      <td>{row.site ?? <span className="muted">estate</span>}</td>
                      <td className="muted">{row.sample}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Popup>
        ) : null}
      </Heading>

      <SettingsForm rows={rows.filter((row) => row.group !== "Mail")} site={null} canEdit={viewer.isSuperadmin} />
    </>
  );
}
