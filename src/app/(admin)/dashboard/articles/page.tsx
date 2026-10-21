/**
 * Articles — the old admin's news list.
 *
 * Drafts and published pieces in one list, newest first, because the
 * question an editor opens this for is "what is waiting on me", and a list
 * that hides drafts cannot answer it.
 */

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { staffArticles } from "@/domain/content/articles";
import { articleTally } from "@/domain/dashboard/catalogue";
import {
  BrandField,
  Chips,
  Empty,
  Filters,
  Heading,
  Panel,
  count,
  one,
  when,
  type Search,
} from "../../ui";

export const metadata = { title: "Articles · Petrosil" };
export const dynamic = "force-dynamic";

const STATUSES = ["draft", "published", "withdrawn"] as const;

const TONE: Record<string, string> = {
  published: "ok",
  draft: "warn",
  withdrawn: "",
};

export default async function ArticlesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const viewer = (await currentViewer())!;
  const search = await searchParams;

  const site = one(search, "site");
  const status = one(search, "status");
  const q = one(search, "q");

  const [brands, tally, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    // Counted in the database, not off the list: 93,000 articles came across
    // and a chip counting the 200 on screen would say "200".
    articleTally(viewer.siteIds, { site, search: q }),
    staffArticles(viewer.siteIds, { site, status, search: q, limit: 200 }),
  ]);

  return (
    <>
      <Heading
        title="Articles"
        sub="Market news and analysis. A premium piece shows its first paragraph to everyone and the rest to subscribers."
      />

      <Panel flush={false}>
        <Filters action="/dashboard/articles">
          <BrandField brands={brands} value={site} />
          <div className="field grow">
            <label htmlFor="q">Search</label>
            <input id="q" name="q" type="search" defaultValue={q ?? ""} placeholder="Title or excerpt" />
          </div>
          {status ? <input type="hidden" name="status" value={status} /> : null}
        </Filters>
      </Panel>

      <div style={{ margin: "14px 0" }}>
        <Chips
          base="/dashboard/articles"
          param="status"
          here={{ site, q }}
          value={status}
          options={[
            { value: "", label: "All", n: tally.all },
            ...STATUSES.map((value) => ({ value, label: value, n: tally[value] })),
          ]}
        />
      </div>

      <Panel
        title={`${count(tally.all)} article${tally.all === 1 ? "" : "s"}`}
        hint={rows.length < tally.all ? `Showing the newest ${count(rows.length)}.` : undefined}
      >
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Status</th>
              <th>Published</th>
              <th className="num">Views</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.title}</strong>
                  <div className="small muted">
                    /{row.slug}
                    {row.premium_only ? " · subscribers only" : ""}
                  </div>
                </td>
                <td>{row.category ?? <span className="muted">none</span>}</td>
                <td>
                  <span className={`badge ${TONE[row.status] ?? ""}`}>{row.status}</span>
                </td>
                <td>{row.published_at ? when(row.published_at) : <span className="muted">—</span>}</td>
                <td className="num">{count(row.views)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <Empty>Nothing written here yet.</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
