/**
 * One newsletter issue: how it will look, and what can be done with it.
 *
 * The preview renders the issue's HTML in a sandboxed frame, so nothing in an
 * issue can run script in the admin. A draft is edited here; an archived or
 * sent issue is read-only and can be copied into a new draft.
 */

import Link from "@/lib/ui/link";
import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { getNewsletter } from "@/domain/content/newsletters";
import { audienceCounts, newsletterDelivery } from "@/domain/content/newsletter-send";
import { can } from "@/domain/staff/permissions";
import { copyAction } from "../actions";
import { EditIssueForm, SendForm, TestSendForm } from "../forms";
import { STATUS } from "../status";
import { Heading, Panel, Tile, count, one, when, type Search } from "@/app/(admin)/ui";

export const dynamic = "force-dynamic";

export default async function NewsletterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug, id } = await params;
  const refused = one(await searchParams, "refused");
  const issue = await getNewsletter(viewer, Number(id));

  if (!issue || issue.site !== slug) {
    notFound();
  }

  const shown = STATUS[issue.status] ?? { label: issue.status, tone: "" };
  const mayKnowSend = issue.status === "draft" && (await can(viewer, issue.siteId, "newsletter-send"));
  const counts = mayKnowSend ? await audienceCounts(viewer, issue.id) : null;
  const delivery = issue.status === "sent" ? await newsletterDelivery(viewer, issue.id) : null;

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
        {refused ? (
          <p className="flash bad" role="alert">
            {refused}
          </p>
        ) : null}
        <div className="bar">
          <TestSendForm id={issue.id} />
          <form action={copyAction} className="inline">
            <input type="hidden" name="id" value={issue.id} />
            <input type="hidden" name="site" value={slug} />
            <button className="ghost" type="submit">
              Copy into a new draft
            </button>
          </form>
          {counts ? <SendForm id={issue.id} site={slug} counts={counts} /> : null}
        </div>
      </Panel>

      {delivery ? (
        <Panel title="Delivery" flush={false}>
          <div className="tiles">
            <Tile n={delivery.recipients} k="recipients" />
            <Tile n={delivery.waiting} k="waiting to go" />
            <Tile n={delivery.sent} k="sent" />
            <Tile n={delivery.failed} k="failed" />
            <Tile n={delivery.opened} k="opened" />
            <Tile n={delivery.optedOut} k="unsubscribed" />
          </div>
          <p className="small muted" style={{ margin: ".4rem 0 0" }}>
            {delivery.waiting > 0 ? "Waiting mails leave with the mail runs, once a mail key is set. " : ""}
            <Link href={`/dashboard/sites/${slug}/deliveries/${delivery.sendId}`}>Every recipient →</Link>
          </p>
        </Panel>
      ) : null}

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
