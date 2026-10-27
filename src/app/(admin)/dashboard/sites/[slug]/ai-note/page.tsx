/**
 * The published price note: the paragraph the price module's AI writes about
 * an update, shown above the brand's price table. The newest is the one on
 * the site; removing it brings the one before back.
 */

import { notFound } from "next/navigation";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { listNotes } from "@/domain/price/notes";
import { NoteCard, WriteNote } from "./forms";
import { Empty, Heading, Panel } from "@/app/(admin)/ui";
import { Popup } from "@/app/(admin)/popup";

export const metadata = { title: "Published AI note · Petrosil" };
export const dynamic = "force-dynamic";

export default async function AiNotePage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;

  if (!(await brandsFor(viewer.siteIds)).some((brand) => brand.slug === slug)) {
    notFound();
  }

  const notes = await listNotes(viewer.siteIds, slug);

  return (
    <>
      <Heading
        title="Published AI note"
        sub="The paragraph above the price table. The price module writes one with each update; the newest is the one readers see."
      >
        <Popup label="Write a note" title="Write a note by hand">
          <WriteNote slug={slug} />
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            For when the module sent none, or the week needs saying differently.
          </p>
        </Popup>
      </Heading>

      <Panel
        title={notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"}, newest first` : "Notes"}
        hint="Corrections and removals keep the module's own text in the activity log."
        flush={false}
      >
        {notes.length ? (
          notes.map((note) => <NoteCard key={note.id} slug={slug} note={note} />)
        ) : (
          <Empty>No note yet. The price module sends one with its next update, or write one by hand.</Empty>
        )}
      </Panel>
    </>
  );
}
