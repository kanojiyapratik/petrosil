/**
 * One enquiry: who wrote, about what, what they said, and who dealt with it.
 *
 * Replying happens in a mailbox, as it always has; the Reply button opens one
 * addressed to the member with the subject filled in.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { getEnquiry } from "@/domain/enquiries/inbox";
import { setStatusAction } from "../actions";
import { KIND, STATUS } from "../labels";
import { Heading, Panel, when } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function EnquiryPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const enquiry = await getEnquiry(viewer, Number(id));

  if (!enquiry) {
    notFound();
  }

  const shown = STATUS[enquiry.status] ?? { label: enquiry.status, tone: "" };
  const replySubject = `Re: ${enquiry.subject ?? enquiry.about ?? "your enquiry"}`;
  const detail = enquiry.detail ?? {};

  const facts: [string, React.ReactNode][] = [
    ["Kind", KIND[enquiry.kind] ?? enquiry.kind],
    ["About", enquiry.about ?? <span className="muted">not recorded</span>],
    ["Name", enquiry.fromName ?? <span className="muted">not recorded on the old site</span>],
    ["Company", enquiry.fromCompany],
    ["Email", enquiry.fromEmail],
    ["Phone", enquiry.fromPhone],
    ["Years", detail.years as string | undefined],
    ["Members", detail.members as string | undefined],
    ["Price quoted", detail.price as string | undefined],
    ["Received", when(enquiry.createdAt.toISOString())],
  ];

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/enquiries`}>
        ← Enquiries
      </Link>

      <Heading title={enquiry.subject ?? enquiry.about ?? "Enquiry"}>
        <span className={`badge ${shown.tone}`}>{shown.label}</span>
      </Heading>

      <Panel title="From and about" flush={false}>
        <table className="tight">
          <tbody>
            {facts
              .filter(([, value]) => value !== null && value !== undefined && value !== "")
              .map(([label, value]) => (
                <tr key={label}>
                  <td style={{ width: "25%" }} className="muted">
                    {label}
                  </td>
                  <td>{value}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Message" flush={false}>
        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{enquiry.message || "(no text)"}</p>
      </Panel>

      <Panel title="Deal with it" flush={false}>
        {enquiry.fromEmail ? (
          <p>
            <a
              className="button"
              href={`mailto:${enquiry.fromEmail}?subject=${encodeURIComponent(replySubject)}`}
            >
              Reply to {enquiry.fromName ?? enquiry.fromEmail}
            </a>
          </p>
        ) : (
          <p className="muted">
            The old site did not record who sent this, so there is no one to reply to.
          </p>
        )}

        {enquiry.handledAt ? (
          <p className="small muted">
            Handled by {enquiry.handledByName ?? "someone since removed"} on {when(enquiry.handledAt.toISOString())}.
          </p>
        ) : null}

        <form action={setStatusAction}>
          <input type="hidden" name="id" value={enquiry.id} />
          <div className="field">
            <label htmlFor="note">Note (optional)</label>
            <textarea id="note" name="note" rows={3} defaultValue={enquiry.note ?? ""} style={{ width: "100%" }} />
          </div>
          <div className="bar" style={{ marginTop: ".5rem" }}>
            {enquiry.status === "handled" ? (
              <button type="submit" name="status" value="new" className="ghost">
                Open it again
              </button>
            ) : (
              <button type="submit" name="status" value="handled">
                Mark handled
              </button>
            )}
          </div>
        </form>
      </Panel>
    </>
  );
}
