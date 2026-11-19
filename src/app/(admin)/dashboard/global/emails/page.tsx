/**
 * System emails, across the brands.
 *
 * Every brand has its own copy of the same twelve built-in emails, plus any
 * staff added to send by hand ("custom-" keys). Copies that say the
 * same thing but for the brand's name count as one wording, so "Same on
 * every brand" means the brands already agree.
 *
 * Each row says what the email is for and what sends it. The list used to
 * be titles with an orange "7 versions" on every row, which read as twelve
 * warnings and said nothing about when anyone receives the email.
 */

import Link from "@/lib/ui/link";

import { currentViewer } from "@/lib/auth/server";
import { CUSTOM_EMAIL, globalEmails } from "@/domain/global/estate";
import { brandsFor } from "@/domain/dashboard/brands";
import { Popup } from "@/app/(admin)/popup";
import { NewGlobalEmail } from "../forms";
import { Empty, Heading, Panel, count } from "../../../ui";
import { WHEN_LABEL, emailAbout } from "./about";

export const metadata = { title: "System emails · Petrosil" };
export const dynamic = "force-dynamic";

export default async function GlobalEmailsPage() {
  const viewer = (await currentViewer())!;
  const [rows, brands] = await Promise.all([globalEmails(viewer.siteIds), brandsFor(viewer.siteIds)]);

  return (
    <>
      <Heading
        title="System emails"
        sub="The emails the brand sites send, and ones you add to send by hand. Open one to edit it and apply it to the brands you choose."
      >
        <Popup label="Add email" title="Add email">
          <NewGlobalEmail brands={brands.map(({ slug, name }) => ({ slug, name }))} />
        </Popup>
      </Heading>

      <Panel title={`${count(rows.length)} email${rows.length === 1 ? "" : "s"}`}>
        <table className="tight emails">
          <thead>
            <tr>
              <th>Email</th>
              <th>Sent</th>
              <th className="num">Brands</th>
              <th>Wording</th>
              <th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const about = emailAbout(row.key);
              const when = about ? WHEN_LABEL[about.when] : null;
              const href = `/dashboard/global/emails/${row.key}/${row.variant}`;

              return (
                <tr key={`${row.key}-${row.variant}`}>
                  <td>
                    <Link className="email-title" href={href}>
                      {row.title}
                    </Link>
                    {row.variant !== "default" ? <span className="tag">{row.variant}</span> : null}
                    {row.key.startsWith(CUSTOM_EMAIL) ? <span className="tag">added by staff</span> : null}
                    {about ? <div className="small muted">{about.what}</div> : null}
                  </td>
                  <td>
                    {when ? (
                      <span className={`badge ${when.tone}`} title={about!.detail}>
                        {when.label}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">
                    {row.brands} of {row.of}
                  </td>
                  <td>
                    {row.versions === 1 ? (
                      <span className="small muted">Same on every brand</span>
                    ) : (
                      <span className="small muted">{row.versions} different wordings</span>
                    )}
                  </td>
                  <td className="num">
                    <Link className="button ghost small" href={href}>
                      Edit
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
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
