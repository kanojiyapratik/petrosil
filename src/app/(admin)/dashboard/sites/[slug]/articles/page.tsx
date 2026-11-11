/**
 * Articles — the old admin's news list.
 *
 * Drafts and published pieces in one list, newest first, because the
 * question an editor opens this for is "what is waiting on me", and a list
 * that hides drafts cannot answer it.
 */

import Link from "@/lib/ui/link";

import { currentViewer } from "@/lib/auth/server";
import { brandsFor } from "@/domain/dashboard/brands";
import { staffArticles } from "@/domain/content/articles";
import { restoreArticleAction } from "./actions";
import { articleTally } from "@/domain/dashboard/catalogue";
import {
  Chips,
  Empty,
  Heading,
  ListBar,
  Panel,
  count,
  one,
  when,
  type Search,
} from "@/app/(admin)/ui";

export const metadata = { title: "Articles · Petrosil" };
export const dynamic = "force-dynamic";

/** "withdrawn" is a taken-down piece: off the site, kept here. Deleted is its own list. */
const STATUSES = [
  { value: "published", label: "Published" },
  { value: "draft", label: "Draft" },
  { value: "withdrawn", label: "Taken down" },
] as const;

const LABEL: Record<string, string> = { published: "published", draft: "draft", withdrawn: "taken down" };

const TONE: Record<string, string> = {
  published: "ok",
  draft: "warn",
  withdrawn: "",
};

export default async function ArticlesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;

  const site = slug;
  const status = one(search, "status");
  const q = one(search, "q");
  const deleted = status === "deleted";
  const refused = one(search, "refused");

  const [brands, tally, rows] = await Promise.all([
    brandsFor(viewer.siteIds),
    // Counted in the database, not off the list: 93,000 articles came across
    // and a chip counting the 200 on screen would say "200".
    articleTally(viewer.siteIds, { site, search: q }),
    staffArticles(viewer.siteIds, { site, status: deleted ? undefined : status, search: q, limit: 200, deleted }),
  ]);

  return (
    <>
      <Heading
        title="Articles"
        sub="Market news and analysis. A premium piece shows its first paragraph to everyone and the rest to subscribers."
      >
        <Link className="button small" href={`/dashboard/sites/${slug}/articles/new`}>
          New article
        </Link>
      </Heading>

      <ListBar action={`/dashboard/sites/${slug}/articles`} q={q} placeholder="Search: title or excerpt" keep={{ status }}>
      <Chips
        base={`/dashboard/sites/${slug}/articles`}
        param="status"
        here={{ site, q }}
        value={status}
        options={[
          { value: "", label: "All", n: tally.all },
          ...STATUSES.map(({ value, label }) => ({ value, label, n: tally[value] })),
          { value: "deleted", label: "Deleted", n: tally.deleted },
        ]}
      />
      </ListBar>

      {refused ? (
        <p className="flash bad" role="alert">
          {refused}
        </p>
      ) : null}

      {deleted ? (
        <p className="note">Deleted articles are hidden from the site and the list, not destroyed. Restore brings one back as it was.</p>
      ) : null}

      <Panel
        title={deleted ? `${count(tally.deleted)} deleted` : `${count(tally.all)} article${tally.all === 1 ? "" : "s"}`}
        hint={rows.length < (deleted ? tally.deleted : tally.all) ? `Showing the newest ${count(rows.length)}.` : undefined}
      >
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Status</th>
              <th>Published</th>
              <th className="num">Views</th>
              {deleted ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {deleted ? (
                    <strong>{row.title}</strong>
                  ) : (
                    <Link href={`/dashboard/sites/${slug}/articles/${row.id}`}>
                      <strong>{row.title}</strong>
                    </Link>
                  )}
                  <div className="small muted">
                    /{row.slug}
                    {row.premium_only ? " · subscribers only" : ""}
                  </div>
                </td>
                <td>{row.category ?? <span className="muted">none</span>}</td>
                <td>
                  <span className={`badge ${deleted ? "bad" : (TONE[row.status] ?? "")}`}>{deleted ? "deleted" : (LABEL[row.status] ?? row.status)}</span>
                </td>
                <td>{row.published_at ? when(row.published_at) : <span className="muted">—</span>}</td>
                <td className="num">{count(row.views)}</td>
                {deleted ? (
                  <td>
                    <form action={restoreArticleAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="site" value={slug} />
                      <button className="small" type="submit">
                        Restore
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={deleted ? 6 : 5}>
                  <Empty>{deleted ? "Nothing deleted." : "Nothing written here yet."}</Empty>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
