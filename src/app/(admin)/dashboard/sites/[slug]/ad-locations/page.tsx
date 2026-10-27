/**
 * Ad placements — the slots on a brand site an ad can occupy.
 *
 * Six per site in the old `adlocations`. The useful pair of numbers is how
 * many ads are assigned to a slot and how many of those are actually running
 * today: the old screen showed only the first, so a slot with four expired
 * ads in it looked sold.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { listPlacements } from "@/domain/dashboard/promotion";
import { NewSlot, SlotRow } from "./forms";
import {
  Empty,
  Heading,
  Panel,
  count,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Ad locations · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AdLocationsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const site = slug;

  const rows = await listPlacements(viewer.siteIds, { site });

  const empty = rows.filter((row) => row.enabled && row.live === 0).length;

  return (
    <>
      <Heading
        title="Ad locations"
        sub="The slots an ad can occupy. A slot with ads in it is not the same as a slot with an ad running."
      >
        <Link className="button ghost small" href={`/dashboard/sites/${slug}/ads`}>
          Ads
        </Link>
      </Heading>

      {empty > 0 ? (
        <div className="note" style={{ marginBottom: 16 }}>
          <strong>{empty}</strong> live slot{empty === 1 ? " has" : "s have"} nothing running in
          {empty === 1 ? " it" : " them"} today.
        </div>
      ) : null}

      <Panel title="New slot" flush={false}>
        <NewSlot slug={slug} />
      </Panel>

      <Panel
        title={`${count(rows.length)} slot${rows.length === 1 ? "" : "s"}`}
        hint="Rename a slot or untick Offered and press Save on its row. A slot with ads in it cannot be deleted."
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Offered</th>
              <th className="num">Ads assigned</th>
              <th className="num">Running today</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <SlotRow key={row.id} slug={slug} row={row} />
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No ad slots defined.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
