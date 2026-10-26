/**
 * The brand's system mail templates.
 *
 * Each one says what sends it. Half of the twelve are sent by nothing yet —
 * the welcome mail, sample reports, report sends and the staff alert wait on
 * their own features — and saying so stops staff polishing a mail nobody gets.
 */

import { currentViewer } from "@/lib/auth/server";
import { listMailTemplates } from "@/domain/content/mail-templates";
import { TemplateForm } from "./form";
import { Empty, Heading, Panel, when } from "@/app/(admin)/ui";

export const metadata = { title: "Mail templates · Petrosil" };
export const dynamic = "force-dynamic";

const VARIANTS: Record<string, string> = { asia: "Asia edition", default: "" };

export default async function MailTemplatesPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const rows = await listMailTemplates(viewer, slug);
  const live = rows.filter((row) => row.sentBy !== null);
  const waiting = rows.filter((row) => row.sentBy === null);

  return (
    <>
      <Heading
        title="Mail templates"
        sub="The mails this brand sends on its own. Edit the wording, or switch one off to stop it."
      />

      {rows.length === 0 ? (
        <Panel title="No templates">
          <Empty>
            This brand has no mail templates. Carry them from the old site with{" "}
            <code>npm run migrate:content -- --from &lt;db&gt; --site {slug} --only mails</code>.
          </Empty>
        </Panel>
      ) : null}

      {[
        { title: "Sent now", list: live },
        { title: "Not sent by anything yet", list: waiting },
      ].map(({ title, list }) =>
        list.length === 0 ? null : (
          <Panel key={title} title={title}>
            <table>
              <tbody>
                {list.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="heading" style={{ marginBottom: 6 }}>
                        <strong>{row.title}</strong>
                        {VARIANTS[row.variant] ? (
                          <span className="badge">{VARIANTS[row.variant]}</span>
                        ) : null}
                        <span className="spacer" />
                        <span className="small muted">
                          {row.sentBy ?? "waits on its feature"} · edited {when(row.updatedAt.toISOString())}
                        </span>
                        {row.enabled ? <span className="badge ok">on</span> : <span className="badge">off</span>}
                      </div>
                      <TemplateForm
                        template={{
                          id: row.id,
                          subject: row.subject,
                          body: row.body,
                          enabled: row.enabled,
                          fields: row.fields,
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ),
      )}
    </>
  );
}
