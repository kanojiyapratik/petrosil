/**
 * One newsletter issue: how it will look, and what can be done with it.
 *
 * The preview renders the issue's HTML in a sandboxed frame, so nothing in an
 * issue can run script in the admin. A draft is edited here; an archived or
 * sent issue is read-only and can be copied into a new draft.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { getNewsletter } from "@/domain/content/newsletters";
import { copyAction } from "../actions";
import { EditIssueForm, TestSendForm } from "../forms";
import { STATUS } from "../status";
import { Heading, Panel, count, when } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function NewsletterPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const issue = await getNewsletter(viewer, Number(id));

  if (!issue || issue.site !== slug) {
    notFound();
  }

  const shown = STATUS[issue.status] ?? { label: issue.status, tone: "" };

  return (
    <>
      <Link className="crumb" href={`/dashboard/sites/${slug}/newsletters`}>
        ← Newsletters
      </Link>

      <Heading
        title={issue.title}
        sub={
          issue.status === "sent" && issue.sentAt
            ? `Sent ${when(issue.sentAt.toISOString())} to ${count(issue.recipients)} people.`
            : issue.status === "archived"
              ? `Written ${when(issue.createdAt.toISOString())} on the old site, which kept no record of whether it was sent.`
              : `Draft${issue.template ? ` from ${issue.template}` : ""}, last edited ${when(issue.updatedAt.toISOString())}.`
        }
      >
        <span className={`badge ${shown.tone}`}>{shown.label}</span>
      </Heading>

      <Panel title="Do something with it" flush={false}>
        <div className="bar">
          <TestSendForm id={issue.id} />
          <form action={copyAction} className="inline">
            <input type="hidden" name="id" value={issue.id} />
            <input type="hidden" name="site" value={slug} />
            <button className="ghost" type="submit">
              Copy into a new draft
            </button>
          </form>
          <button type="button" disabled title="Waiting on a decision: which list a newsletter goes to.">
            Send to subscribers
          </button>
        </div>
        <p className="small muted" style={{ margin: ".4rem 0 0" }}>
          Sending to subscribers is not switched on yet: it needs a decision on who receives it (a Brevo list, or
          this brand&apos;s own subscribers).
        </p>
      </Panel>

      {issue.status === "draft" ? (
        <Panel title="Edit" flush={false}>
          <EditIssueForm id={issue.id} title={issue.title} body={issue.body} />
        </Panel>
      ) : null}

      <Panel title="Preview" flush={false}>
        <iframe
          title={`Preview of ${issue.title}`}
          sandbox=""
          srcDoc={issue.body}
          style={{ width: "100%", height: 900, border: "1px solid var(--line, #ddd)", background: "#fff" }}
        />
      </Panel>
    </>
  );
}
