/** One send: what it said, and each recipient's mail — queued, sent or failed (and why), and opened. */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { getSend } from "@/domain/reports/sending";
import { Heading, Panel, Tile, when } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { sent: "ok", failed: "bad", queued: "warn" };

export default async function DeliveryPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const send = await getSend(viewer, Number(id));

  if (!send || send.site !== slug) {
    notFound();
  }

  const queued = send.recipients.filter((row) => row.status === "queued").length;

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/deliveries`}>
        ← Delivery log
      </Link>

      <Heading
        title={send.about ?? send.subject}
        sub={`${send.kind === "sample" ? "Sample" : "Report send"}${send.sentByName ? ` by ${send.sentByName}` : ""}, ${when(send.createdAt.toISOString())}.`}
      />

      <div className="tiles">
        <Tile n={send.recipients.length} k="recipients" />
        <Tile n={queued} k="waiting to go" />
        <Tile n={send.sent} k="sent" />
        <Tile n={send.failed} k="failed" />
        <Tile n={send.opened} k="opened" />
      </div>

      {queued > 0 ? (
        <p className="small muted">
          Waiting mails leave with the next mail run, once a mail key is set (BREVO_API_KEY and MAIL_FROM).
        </p>
      ) : null}

      <Panel title="Recipients">
        <table className="tight">
          <thead>
            <tr>
              <th>Who</th>
              <th>Status</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {send.recipients.map((row) => (
              <tr key={row.email}>
                <td>
                  {row.name ? <strong>{row.name}</strong> : null} <span className="muted small">{row.email}</span>
                </td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>{row.status}</span>
                  {row.error ? <div className="small muted">{row.error}</div> : null}
                </td>
                <td>{row.openedAt ? when(row.openedAt.toISOString()) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="What it said" flush={false}>
        <p>
          <strong>{send.subject}</strong>
        </p>
        <iframe
          title="The message as written"
          sandbox=""
          srcDoc={send.body}
          style={{ width: "100%", height: 360, border: "1px solid var(--line, #ddd)", background: "#fff" }}
        />
      </Panel>
    </>
  );
}
