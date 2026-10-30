/**
 * AI price update — the brand's market reports become a draft price update.
 *
 * Three steps, one per screen: read the reports (here), check what was read
 * (readings/[id]), review the AI's draft and save it (drafts/[id]). Saving
 * makes a draft price update; nothing reaches the website until it is
 * committed on the Price update screen, as with every other update.
 *
 * The AI work is the engine's; this screen only ever acts on the brand in
 * the path, which is the point of having it here rather than on a console
 * that asks which website first.
 */

import Link from "next/link";

import { currentViewer } from "@/lib/auth/server";
import { AccessError } from "@/lib/auth/guard";
import { EngineError } from "@/lib/engine/client";
import { aiDrafts, aiOverview } from "@/domain/ai/update";
import { Empty, Heading, Panel, when } from "@/app/(admin)/ui";
import { UploadForm } from "./forms";

export const metadata = { title: "AI price update · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AiUpdatePage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  let loaded;

  try {
    loaded = await Promise.all([aiOverview(viewer, slug), aiDrafts(viewer, slug)]);
  } catch (error) {
    if (error instanceof AccessError || error instanceof EngineError) {
      return (
        <>
          <Heading title="AI price update" />
          <p className="flash bad" role="alert">
            {error.message}
          </p>
        </>
      );
    }

    throw error;
  }

  const [overview, drafts] = loaded;
  const waiting = overview.waiting;
  const waitingRows = waiting ? waiting.files.reduce((sum, file) => sum + file.rows.length, 0) : 0;

  return (
    <>
      <Heading
        title="AI price update"
        sub="Read this week's market reports, check what was read, review the AI's prices and save them as a price update. Nothing reaches the website until that update is committed."
      />

      {waiting ? (
        <p className="flash" role="status">
          Reports read on {when(waiting.created_at)} by {waiting.created_by} are waiting to be checked ({waiting.files.length}{" "}
          {waiting.files.length === 1 ? "report" : "reports"}, {waitingRows} prices).{" "}
          <Link href={`/dashboard/sites/${slug}/ai-update/readings/${waiting.id}`}>Check them</Link>
        </p>
      ) : null}

      <Panel title="1 · Read the reports" hint={`Up to ${overview.limits.documents} files, 10 MB each: PDF, Word, Excel or text.`} flush={false}>
        <UploadForm slug={slug} instructions={overview.site.instructions ?? ""} max={overview.limits.documents} />
      </Panel>

      <Panel title="Past AI drafts" hint="Every draft is kept, saved or not, with what the AI suggested and what was saved.">
        {drafts.length ? (
          <table>
            <thead>
              <tr>
                <th>Draft</th>
                <th>Made</th>
                <th>Prices for</th>
                <th>Model</th>
                <th className="num">Priced</th>
                <th className="num">Saved</th>
                <th>Price update</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => (
                <tr key={draft.id}>
                  <td>
                    <Link href={`/dashboard/sites/${slug}/ai-update/drafts/${draft.id}`}>#{draft.id}</Link>
                  </td>
                  <td>
                    {when(draft.created_at)}
                    <div className="small muted">{draft.created_by}</div>
                  </td>
                  <td>{draft.price_date ?? "—"}</td>
                  <td className="small">{draft.model ?? "—"}</td>
                  <td className="num">
                    {draft.priced} of {draft.locations}
                  </td>
                  <td className="num">{draft.batch_id ? draft.kept : "—"}</td>
                  <td>
                    {draft.batch_id ? (
                      <Link href={`/dashboard/sites/${slug}/batches/${draft.batch_id}`}>#{draft.batch_id}</Link>
                    ) : (
                      <span className="badge warn">not saved</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No AI drafts for this brand yet.</Empty>
        )}
      </Panel>
    </>
  );
}
