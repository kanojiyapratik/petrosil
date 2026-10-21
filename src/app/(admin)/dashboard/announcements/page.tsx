/**
 * The announcement strip.
 *
 * "Live" is computed from today's date rather than from the enabled flag,
 * because the question is never "is it switched on" — it is "is the notice
 * about Friday's report still on the site in March".
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listAnnouncements } from "@/domain/dashboard/catalogue";
import {
  BrandField,
  Empty,
  Filters,
  Heading,
  Panel,
  count,
  one,
  type Search,
} from "../../ui";

export const metadata = { title: "Announcements · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;
  const site = one(search, "site");

  const [brands, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    listAnnouncements(viewer.siteIds, { site }),
  ]);

  const live = rows.filter((row) => row.live).length;

  return (
    <>
      <Heading
        title="Announcements"
        sub="The strip across the top of a brand site, with the window it shows in."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/announcements">
          <BrandField brands={brands} value={site} />
        </Filters>
      </Panel>

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(live)}</div>
          <div className="k">showing right now</div>
        </div>
        <div className="tile">
          <div className="n">{count(rows.length - live)}</div>
          <div className="k">dormant</div>
        </div>
      </div>

      <Panel title={`${count(rows.length)} announcement${rows.length === 1 ? "" : "s"}`}>
        <table>
          <thead>
            <tr>
              <th>Notice</th>
              <th>Brand</th>
              <th>From</th>
              <th>Until</th>
              <th>Showing</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.body}
                  {row.link ? (
                    <div className="small muted">
                      links to <code>{row.link}</code>
                    </div>
                  ) : null}
                </td>
                <td>{row.site_name}</td>
                <td>{row.starts_at ?? <span className="muted">already</span>}</td>
                <td>{row.ends_at ?? <span className="muted">no end</span>}</td>
                <td>
                  {row.live ? (
                    <span className="badge ok">live</span>
                  ) : row.enabled ? (
                    <span className="badge warn">outside its window</span>
                  ) : (
                    <span className="badge">switched off</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No announcements set.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
