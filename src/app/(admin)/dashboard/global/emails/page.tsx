/**
 * System emails, across the brands.
 *
 * Every brand has its own copy of the same twelve emails. Copies that say the
 * same thing but for the brand's name count as one version, so "in step"
 * means the brands already agree and "6 versions" means they drifted.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { globalEmails } from "@/domain/global/estate";
import { Empty, Heading, Panel, count } from "../../../ui";

export const metadata = { title: "System emails · Petrosil" };
export const dynamic = "force-dynamic";

export default async function GlobalEmailsPage() {
  const viewer = (await currentViewer())!;
  const rows = await globalEmails(viewer.siteIds);

  return (
    <>
      <Heading
        title="System emails"
        sub="The emails every brand sends by itself. Edit one here and apply it to the brands you tick."
      />

      <Panel title={`${count(rows.length)} email${rows.length === 1 ? "" : "s"}`}>
        <table className="tight">
          <thead>
            <tr>
              <th>Email</th>
              <th className="num">Brands with it</th>
              <th className="num">Versions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.key}-${row.variant}`}>
                <td>
                  <Link href={`/dashboard/global/emails/${row.key}/${row.variant}`}>
                    <strong>{row.title}</strong>
                  </Link>
                  {row.variant !== "default" ? (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      {row.variant}
                    </span>
                  ) : null}
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
                  <Empty>No system emails on your brands yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
