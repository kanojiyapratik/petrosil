/**
 * Locations — the old admin's "Manage locations", which is the screen the
 * editorial team lives in.
 *
 * It answers the two questions that screen was always opened for: what is
 * each market's latest figure, and which markets are published. Everything
 * else (the history, the batch that set it) is one click away rather than
 * crammed into the row.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { enabledCurrencies, listLocations } from "@/domain/dashboard/locations";
import { LocationForm } from "./form";
import { Popup } from "@/app/(admin)/popup";
import {
  Change,
  Chips,
  Empty,
  Heading,
  ListBar,
  Pager,
  Panel,
  count,
  money,
  one,
  pageParam,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Locations · Petrosil" };
export const dynamic = "force-dynamic";

export default async function LocationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;

  const site = slug;
  const q = one(search, "q");
  const shown = one(search, "shown");
  const page = pageParam(one(search, "page"));

  const [rows] = await Promise.all([
    listLocations(viewer.siteIds, {
      site,
      search: q,
      visible: shown === "live" ? true : shown === "held" ? false : undefined,
    }),
  ]);

  const live = rows.filter((row) => row.visible).length;

  // Paged here rather than in the query: `listLocations` computes each
  // row’s latest and previous price in one pass and `locationDetail` reuses
  // it, so the round trip is the same either way — what a page of 50 saves
  // is 500KB of HTML for an estate of 626 markets.
  const PER_PAGE = 50;
  const shownRows = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <>
      <Heading
        title="Locations"
        sub="Every market this brand assesses. A held location keeps its history but is not published."
      >
        <Popup label="New location" title="New location">
          <LocationForm slug={slug} currencies={await enabledCurrencies()} />
        </Popup>
      </Heading>

      <ListBar action={`/dashboard/sites/${slug}/locations`} q={q} placeholder="Search locations" keep={{ shown }}>
        <Chips
          base={`/dashboard/sites/${slug}/locations`}
          param="shown"
          here={{ site, q }}
          value={shown}
          options={[
            { value: "", label: "All", n: rows.length },
            { value: "live", label: "Published", n: live },
            { value: "held", label: "Held", n: rows.length - live },
          ]}
        />
      </ListBar>

      <Panel
        title={`${count(rows.length)} location${rows.length === 1 ? "" : "s"}`}
        hint="Latest figure and how it moved against the one before it."
      >
        <table className="tight">
          <thead>
            <tr>
              <th>Location</th>
              <th className="num">Latest</th>
              <th className="num">Change</th>
              <th>As of</th>
              <th className="num">Prices</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shownRows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/dashboard/sites/${slug}/locations/${row.id}`}>
                    <strong>{row.title}</strong>
                  </Link>
                </td>
                <td className="num">{money(row.latest_price, row.currency)}</td>
                <td className="num" title={row.previous_price !== null ? `was ${money(row.previous_price, row.currency)}` : undefined}>
                  <Change pct={row.change_pct} />
                </td>
                <td>{row.latest_pricedate ?? <span className="muted">never</span>}</td>
                <td className="num">{count(row.price_rows)}</td>
                <td>
                  <span className={`badge ${row.visible ? "ok" : ""}`}>
                    {row.visible ? "live" : "held"}
                  </span>
                </td>
              </tr>
            ))}
            {shownRows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty>Nothing matches that. Try a shorter search.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Pager
          base={`/dashboard/sites/${slug}/locations`}
          here={{ site, q, shown }}
          page={page}
          perPage={PER_PAGE}
          total={rows.length}
        />
      </Panel>
    </>
  );
}
