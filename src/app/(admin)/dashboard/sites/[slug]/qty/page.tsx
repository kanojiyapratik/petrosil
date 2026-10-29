/**
 * Import and export quantities.
 *
 * Monthly figures per reporting country: an export sheet lists what a
 * country sent to each partner that month, an import sheet what it received
 * from each. 630,000 of them came across from the old sites, and since the
 * price module never covered quantities, this is where they are entered now.
 *
 * The countries are one list per brand, shared by both kinds.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { SHEET_KINDS, reportingPlaces, tradePlaceList, type SheetKind } from "@/domain/trade/sheets";
import { today } from "@/domain/price/dates";
import { NewPlace, OpenMonth, PlaceRow } from "./forms";
import { Chips, Empty, Heading, Panel, count, one, type Search } from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Import and export quantities · Petrosil" };
export const dynamic = "force-dynamic";

export default async function QuantitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const asked = one(await searchParams, "kind");
  const kind: SheetKind = (SHEET_KINDS as readonly string[]).includes(asked ?? "") ? (asked as SheetKind) : "export";

  if (!(await brandsFor(viewer.siteIds)).some((brand) => brand.slug === slug)) {
    notFound();
  }

  const [reporting, places] = await Promise.all([
    reportingPlaces(viewer.siteIds, { site: slug, kind }),
    tradePlaceList(viewer.siteIds, slug),
  ]);

  return (
    <>
      <Heading
        title="Import and export quantities"
        sub="Monthly figures per reporting country, entered one month's sheet at a time."
      >
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/qty/other`}>
          Older qty trend figures
        </Link>
        <Popup label={`Countries (${count(places.length)})`} title="Countries" ghost>
          <NewPlace slug={slug} />
          <p className="small muted" style={{ margin: "10px 0 14px" }}>
            One list for both imports and exports. Rename or hide a country in its row.
          </p>
          <table className="tight">
            <tbody>
              {places.map((place) => (
                <PlaceRow key={place.id} slug={slug} row={place} />
              ))}
            </tbody>
          </table>
        </Popup>
        <Popup label={`Enter ${kind}s for a month`} title={`Enter ${kind}s for a month`}>
          <OpenMonth slug={slug} kind={kind} places={places} month={today().slice(0, 7)} />
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            A month that already has figures opens with them filled in, ready to change.
          </p>
        </Popup>
      </Heading>

      <div className="listbar">
        <Chips
          base={`/dashboard/sites/${slug}/qty`}
          param="kind"
          here={{}}
          value={kind}
          options={[
            { value: "export", label: "Exports" },
            { value: "import", label: "Imports" },
          ]}
        />
      </div>

      <Panel
        title={`${count(reporting.length)} countr${reporting.length === 1 ? "y reports" : "ies report"} ${kind}s`}
        hint="Open one to see its months."
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Reporting country</th>
              <th className="num">Months</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {reporting.map((place) => (
              <tr key={place.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/qty/${kind}/${place.id}`}>
                    <strong>{place.title}</strong>
                  </Link>
                </td>
                <td className="num">{count(place.months)}</td>
                <td>{place.latest ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
            {reporting.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <Empty>No {kind} figures yet. Enter a month to start.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
