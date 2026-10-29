/**
 * The AI market notes: the newest in full, then the archive. Written from
 * movements only, never figures, so the whole page is free to read.
 */

import { notFound } from "next/navigation";

import { insightsFor } from "@/domain/public/insights";
import { liveBrandBySlug } from "@/lib/public/reader";
import { plainText } from "@/lib/public/html";
import { Pager, day, pageParam } from "../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI market insights" };

const PER_PAGE = 15;

export default async function Insights({
  params,
  searchParams,
}: {
  params: Promise<{ site: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { site } = await params;
  const brand = await liveBrandBySlug(site);

  if (!brand) {
    notFound();
  }

  const page = pageParam((await searchParams).page);
  const notes = await insightsFor(brand.id, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE });

  return (
    <section className="bs-card">
      <div className="bs-head">
        <h1>AI market insights</h1>
      </div>
      <p className="bs-sub">
        A short read of the week&apos;s price movements, written by our AI from the prices our editors publish.
      </p>

      {notes.archive.length === 0 ? (
        <div className="bs-empty">No market notes yet.</div>
      ) : (
        <div className="bs-stack" style={{ gap: 14 }}>
          {notes.archive.map((note, index) => (
            <article key={note.id} className={index === 0 && page === 1 ? "bs-insight" : "bs-row"} style={{ display: "block" }}>
              <time className="num" dateTime={note.created_at} style={{ display: "block", marginTop: 0 }}>
                {day(note.created_at)}
              </time>
              <p style={{ margin: "6px 0 0" }}>{plainText(note.summary, 2000)}</p>
            </article>
          ))}
        </div>
      )}

      <Pager base={`/${site}/ai-market-insights`} page={page} pages={Math.ceil(notes.total / PER_PAGE)} />
    </section>
  );
}
