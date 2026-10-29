/**
 * Site defaults — the values every brand follows unless it sets its own.
 *
 * These used to open first on each brand's own Settings tab, beside chips
 * for all nine brands: standing in Base Oil Report, you were editing the
 * estate, one click from editing Bitumart. A brand's tab now edits that
 * brand alone, and the estate's defaults live here with the rest of what the
 * brands share.
 *
 * Keys found in the database that the catalogue does not know are listed at
 * the bottom rather than presented as settings: 621 rows came across and a
 * good number of them were read by nothing.
 */

import { currentViewer } from "@/lib/auth/server";
import { settingsFor, strandedSettings } from "@/domain/dashboard/settings";
import { SettingsForm } from "../../sites/[slug]/settings/form";
import { Heading, Panel, count } from "../../../ui";

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
      />

      <SettingsForm rows={rows.filter((row) => row.group !== "Mail")} site={null} canEdit={viewer.isSuperadmin} />

      {stranded.length > 0 ? (
        <Panel title="Carried over, read by nothing" hint={`${count(stranded.length)} key${stranded.length === 1 ? "" : "s"}`}>
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
        </Panel>
      ) : null}
    </>
  );
}
