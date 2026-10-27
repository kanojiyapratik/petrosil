/**
 * Common pages, across the brands: about us, terms, privacy and the rest.
 *
 * All nine brands have the same thirteen pages. Copies that say the same
 * thing but for the brand's name count as one version.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { globalPages } from "@/domain/global/estate";
import { NewGlobalPage } from "../forms";
import { Empty, Heading, Panel, count } from "../../../ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Common pages · Petrosil" };
export const dynamic = "force-dynamic";

export default async function GlobalPagesPage() {
  const viewer = (await currentViewer())!;
  const [rows, brands] = await Promise.all([globalPages(viewer.siteIds), brandsFor(viewer.siteIds)]);

  return (
    <>
      <Heading
        title="Common pages"
        sub="Every page on the brand sites. Edit one here and apply it to the brands you tick; a page only one brand has is edited the same way, with that brand ticked."
      >
        <Popup label="New page" title="New page">
          <NewGlobalPage brands={brands.map(({ slug, name }) => ({ slug, name }))} />
        </Popup>
      </Heading>

      <Panel title={`${count(rows.length)} page${rows.length === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Page</th>
              <th className="num">Brands with it</th>
              <th className="num">Versions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug}>
                <td>
                  <Link href={`/dashboard/global/pages/${row.slug}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  <div className="small muted">/{row.slug}</div>
                </td>
                <td className="num">
                  {row.brands} of {row.of}
                </td>
                <td className="num">
                  {row.versions === 1 ? (
                    <span className="badge ok">in step</span>
                  ) : (
                    <span className="badge warn">{row.versions} versions</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <Empty>No pages on your brands yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
