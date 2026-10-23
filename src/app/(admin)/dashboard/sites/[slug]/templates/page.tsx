/**
 * Newsletter templates — the wrapper an issue is sent in.
 *
 * Four per brand in the old schema, which is 36 across the estate and
 * presumably the same four nine times. The count of issues using each is
 * what says which are real.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listTemplates } from "@/domain/dashboard/promotion";
import {
  Empty,
  Heading,
  Panel,
  count,
  one,
  when,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Templates · Petrosil" };
export const dynamic = "force-dynamic";

export default async function TemplatesPage({
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
    listTemplates(viewer.siteIds, { site }),
  ]);

  return (
    <>
      <Heading title="Templates" sub="The wrapper a newsletter is sent in." />

      <Panel title={`${count(rows.length)} template${rows.length === 1 ? "" : "s"}`}>
        <table>
          <thead>
            <tr>
              <th>Template</th>
              <th>Brand</th>
              <th>In use</th>
              <th className="num">Issues sent with it</th>
              <th>Last edited</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.title}</strong>
                </td>
                <td>{row.site_name}</td>
                <td>
                  <span className={`badge ${row.enabled ? "ok" : ""}`}>
                    {row.enabled ? "yes" : "retired"}
                  </span>
                </td>
                <td className="num">
                  {row.used_by === 0 ? <span className="muted">never</span> : count(row.used_by)}
                </td>
                <td>{when(row.updated_at)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>No templates. A newsletter will go out unwrapped.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
