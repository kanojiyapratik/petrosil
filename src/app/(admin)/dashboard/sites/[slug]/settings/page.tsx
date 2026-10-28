/**
 * General settings.
 *
 * With no brand chosen this edits the estate's defaults; choose a brand and
 * it edits that brand's overrides, and each field says which it is showing
 * you. The old arrangement was 69 rows per site, nine times over, with no
 * defaults and therefore no way to change one thing everywhere.
 *
 * Keys found in the database that the catalogue does not know are listed at
 * the bottom rather than presented as settings: 621 rows came across and a
 * good number of them were read by nothing.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { settingsFor, strandedSettings } from "@/domain/dashboard/settings";
import { SettingsForm } from "./form";
import { Heading, Panel, count, one, type Search } from "@/app/(admin)/ui";

export const metadata = { title: "Settings · Petrosil" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const site = one(search, "site") ?? null;

  const [brands, rows, stranded] = await Promise.all([
    brandsFor(viewer.siteIds),
    settingsFor(viewer.siteIds, { site: site ?? undefined }),
    strandedSettings(viewer.siteIds),
  ]);

  const chosen = brands.find((brand) => brand.slug === site);
  const canEdit = site ? true : viewer.isSuperadmin;

  return (
    <>
      <Heading
        title="Settings"
        sub={
          chosen
            ? `Overrides for ${chosen.name}. Anything left as the estate's value follows the estate.`
            : "The estate's defaults. Every brand follows these unless it sets its own."
        }
      />

      <div className="chips" style={{ marginBottom: 16 }}>
        <Link className={`chip${site ? "" : " on"}`} href={`/dashboard/sites/${slug}/settings`}>
          Estate defaults
        </Link>
        {brands.map((brand) => (
          <Link
            key={brand.slug}
            className={`chip${site === brand.slug ? " on" : ""}`}
            href={`/dashboard/sites/${slug}/settings?site=${brand.slug}`}
          >
            {brand.name}
          </Link>
        ))}
      </div>

      {/* A brand's sender and the old SMTP login have their own screen, where the sender is tested before it is used. */}
      <p className="small muted" style={{ marginTop: 0 }}>
        The sender address, reply-to and the old site&rsquo;s SMTP login are on{" "}
        <Link href={`/dashboard/sites/${slug}/settings/mail`}>Mail</Link>.
      </p>

      <SettingsForm rows={rows.filter((row) => row.group !== "Mail")} site={site} canEdit={canEdit} />

      {stranded.length > 0 ? (
        <Panel
          title="Carried over, read by nothing"
          hint={`${count(stranded.length)} key${stranded.length === 1 ? "" : "s"}`}
        >
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
