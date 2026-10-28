/**
 * Mail — how a brand's mail leaves, who it is from, and the old site's SMTP
 * login that nothing reads any more. The rules are in
 * `domain/mail/brand-mail.ts`.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { can } from "@/domain/staff/permissions";
import { brandMail } from "@/domain/mail/brand-mail";
import { jobsEnabled } from "@/lib/jobs/jobs";
import { DeleteOld, SenderForm, TestForm } from "./forms";
import { Heading, Panel, count } from "@/app/(admin)/ui";

export const metadata = { title: "Mail · Petrosil" };
export const dynamic = "force-dynamic";

export default async function MailPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const mail = await brandMail(viewer, { site: slug });
  const [canEdit, canDelete] = await Promise.all([
    can(viewer, mail.brand.id, "setting-edit"),
    can(viewer, mail.brand.id, "setting-delete"),
  ]);
  const jobs = jobsEnabled();
  const { sender, transport, week } = mail;

  return (
    <>
      <Heading
        title="Mail"
        sub={`How ${mail.brand.name}'s mail leaves, and who it is from. The mail key itself is set on the server, not here.`}
      />

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(week.sent)}</div>
          <div className="k">sent in the last 7 days</div>
        </div>
        <div className="tile">
          <div className="n">{count(week.waiting)}</div>
          <div className="k">waiting to go</div>
        </div>
        <div className="tile">
          <div className="n">{count(week.failed)}</div>
          <div className="k">given up on in the last 7 days</div>
        </div>
      </div>

      <Panel title="How mail leaves" flush={false} aside={<Link href={`/dashboard/sites/${slug}/deliveries`}>Delivery log</Link>}>
        <table className="tight">
          <tbody>
            <tr>
              <td>Provider</td>
              <td>
                {transport.ready ? (
                  <span className="badge ok">Brevo, connected</span>
                ) : (
                  <>
                    <span className="badge bad">not connected</span>
                    <div className="small muted">Mail waits in the queue until BREVO_API_KEY and MAIL_FROM are set on the server. Nothing is lost.</div>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <td>Background sending</td>
              <td>
                {jobs ? (
                  <span className="badge ok">on, every minute</span>
                ) : (
                  <>
                    <span className="badge warn">off on this machine</span>
                    <div className="small muted">On by default in production; here only with JOBS=on.</div>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <td>Goes out from</td>
              <td>
                {sender.sendsFrom ? (
                  <>
                    &ldquo;{mail.brand.name}&rdquo; &lt;{sender.sendsFrom}&gt;
                  </>
                ) : (
                  <span className="muted">no address yet</span>
                )}
                <div className="small muted">
                  {sender.confirmed ? "The brand's own address, confirmed by a test mail." : "The estate's address, under the brand's name."}
                </div>
              </td>
            </tr>
            {week.lastError ? (
              <tr>
                <td>Last problem</td>
                <td className="small bad">{week.lastError}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <Panel title="This brand's sender" flush={false}>
        <SenderForm slug={slug} fromAddress={sender.fromAddress} replyTo={sender.replyTo} canEdit={canEdit} />

        {sender.fromAddress && canEdit ? (
          <div className="note" style={{ marginTop: 16 }}>
            {sender.confirmed ? (
              <p className="small" style={{ marginTop: 0 }}>
                <strong>{sender.fromAddress}</strong> is confirmed. Send another test any time to check it still works.
              </p>
            ) : (
              <p className="small" style={{ marginTop: 0 }}>
                <strong>{sender.fromAddress} is not in use yet.</strong> Brevo refuses a sender it has not verified, so the brand&rsquo;s mail
                keeps going from the estate&rsquo;s address until a test from this one goes through.
              </p>
            )}
            {transport.ready ? (
              <TestForm slug={slug} from={sender.fromAddress} to={viewer.identity.user.email} />
            ) : (
              <p className="small muted">A test can be sent once the provider is connected.</p>
            )}
          </div>
        ) : null}
      </Panel>

      {mail.old.length ? (
        <Panel title="The old site's credentials" hint="carried over, used by nothing" flush={false}>
          <p className="small" style={{ marginTop: 0 }}>
            The old site sent its mail through its own SMTP login. This platform sends through Brevo, so these are read by nothing. The
            password is a live key stored in plain text; deleting it here does not switch it off at the provider.
          </p>
          <table className="tight" style={{ marginBottom: 12 }}>
            <tbody>
              {mail.old.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>
                    <code>{row.value}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canDelete ? <DeleteOld slug={slug} count={mail.old.length} /> : null}
        </Panel>
      ) : null}
    </>
  );
}
