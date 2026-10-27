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
import { NoticeForm } from "./form";
import { removeNotice } from "./actions";
import {
  Empty,
  Heading,
  Panel,
  count,
  one,
  type Search,
} from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Announcements · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AnnouncementsPage({
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
      >
        <Popup label="New notice" title="New notice">
          <NoticeForm brands={brands} onlySite={site} />
        </Popup>
      </Heading>

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
              <th>Each notice, as it is and as you would change it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <div className="heading" style={{ marginBottom: 6 }}>
                    <span className="small muted">{row.site_name}</span>
                    <span className="spacer" />
                    {row.live ? (
                      <span className="badge ok">live</span>
                    ) : row.enabled ? (
                      <span className="badge warn">outside its window</span>
                    ) : (
                      <span className="badge">switched off</span>
                    )}
                    <form action={removeNotice} className="inline">
                      <input type="hidden" name="id" value={row.id} />
                      <button className="ghost small" type="submit">
                        Remove
                      </button>
                    </form>
                  </div>
                  <NoticeForm brands={brands} notice={row} />
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td>
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
