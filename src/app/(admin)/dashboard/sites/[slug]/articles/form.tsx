"use client";

/**
 * The article form, for a new piece and for an existing one.
 *
 * One component for both because they are the same fields; what differs is
 * which buttons sit at the bottom and whether the brand can still be chosen.
 * A new article is always a draft — publishing is its own audited act — so
 * the create form has no Publish button at all rather than one that lies.
 *
 * The body is written in a formatting editor, never as raw HTML. "Take down"
 * only takes a piece off the brand site; deleting is a separate, confirmed
 * button below the form (DeleteArticle), and even that can be undone.
 */

import { useActionState, useState } from "react";
import Link from "@/lib/ui/link";

import type { Brand } from "@/domain/dashboard/brands";
import type { ArticleAuthor, ArticleForEdit } from "@/domain/content/articles";
import { RichEditor } from "@/app/(admin)/rich-editor";
import { CategoryPicker, CoverImage } from "./fields";
import { createArticleAction, saveArticleAction, type ArticleFormResult } from "./actions";

type Category = { id: number; site: string; name: string };

const STATUS_LABEL: Record<string, string> = {
  published: "Published",
  draft: "Draft",
  withdrawn: "Taken down",
};

export function ArticleForm({
  slug,
  brands,
  categories,
  authors,
  article,
  body,
  me,
}: {
  /** The brand this editor is standing in, for its own links. */
  slug: string;
  brands: Brand[];
  categories: Category[];
  authors: ArticleAuthor[];
  article?: ArticleForEdit;
  /** The body as cleaned HTML, ready for the editor. */
  body: string;
  /** The signed-in person, the default author of a new piece. */
  me: number;
}) {
  const editing = article !== undefined;

  const [state, action, pending] = useActionState(
    editing ? saveArticleAction : createArticleAction,
    null as ArticleFormResult,
  );
  const [site, setSite] = useState(article?.site ?? (brands.some((b) => b.slug === slug) ? slug : (brands[0]?.slug ?? "")));

  const published = article?.status === "published";
  const author = article ? article.author_id : authors.some((a) => a.id === me) ? me : null;

  return (
    <form action={action}>
      {editing ? <input type="hidden" name="id" value={article.id} /> : null}
      {/* The brand, for the actions' redirects: on an existing piece it cannot change. */}
      {editing ? <input type="hidden" name="site" value={article.site} /> : null}

      {state?.error ? (
        <p className="flash bad" role="alert">
          {state.error}
        </p>
      ) : null}
      {state?.saved ? (
        <p className="flash" role="status">
          {state.saved}
        </p>
      ) : null}

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The article</h2>
          </div>
          <div className="body">
            <div className="field">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                name="title"
                type="text"
                defaultValue={article?.title ?? ""}
                required
                autoFocus={!editing}
                maxLength={255}
              />
            </div>

            <div className="field">
              <label htmlFor="excerpt">Summary</label>
              <textarea id="excerpt" name="excerpt" rows={3} maxLength={2000} defaultValue={article?.excerpt ?? ""} />
              <div className="small muted">
                Two or three sentences shown to everyone, including on a subscribers-only piece — the reason to
                read on.
              </div>
            </div>

            <div className="field">
              <label htmlFor="keywords">Keywords</label>
              <input id="keywords" name="keywords" type="text" maxLength={255} defaultValue={article?.keywords ?? ""} placeholder="Thailand, AMEA, Group II" />
              <div className="small muted">Separate with commas. Search finds articles by these as well as by title.</div>
            </div>

            <div className="field">
              <label>Article text</label>
              <RichEditor name="body" initial={body} site={site} />
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="head">
              <h2>Details</h2>
            </div>
            <div className="body">
              {editing ? (
                <dl className="kv">
                  <dt>Brand</dt>
                  <dd>{article.site_name}</dd>
                  <dt>Address</dt>
                  <dd>
                    <code>/{article.slug}</code>
                  </dd>
                </dl>
              ) : (
                <div className="field">
                  <label htmlFor="site">Brand</label>
                  <select id="site" name="site" value={site} onChange={(event) => setSite(event.target.value)} required>
                    {brands.map((brand) => (
                      <option key={brand.slug} value={brand.slug}>
                        {brand.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field">
                <label htmlFor="author_id">Author</label>
                <select id="author_id" name="author_id" defaultValue={author ?? ""}>
                  <option value="">No author shown</option>
                  {authors.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {authors.filter((other) => other.name === person.name).length > 1 ? ` (${person.email})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <CategoryPicker
                site={site}
                options={categories.filter((category) => category.site === site).map(({ id, name }) => ({ id, name }))}
                value={article?.category_id ?? null}
              />

              <CoverImage site={site} name="hero_image" initial={article?.hero_image ?? null} />

              <div className="field">
                <label>
                  <input type="checkbox" name="premium_only" defaultChecked={article?.premium_only ?? false} /> Subscribers
                  only
                </label>
                <div className="small muted">Readers who have not paid see the title and summary, not the text.</div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>{editing ? "Publishing" : "Saving"}</h2>
            </div>
            <div className="body">
              {editing ? (
                <>
                  <dl className="kv">
                    <dt>Now</dt>
                    <dd>
                      <span className={`badge ${published ? "ok" : article.status === "withdrawn" ? "" : "warn"}`}>
                        {STATUS_LABEL[article.status] ?? article.status}
                      </span>
                    </dd>
                    <dt>First published</dt>
                    <dd>{article.published_at ? article.published_at.slice(0, 10) : "never"}</dd>
                    <dt>Views</dt>
                    <dd>{article.views.toLocaleString("en-IN")}</dd>
                  </dl>

                  <div className="actions" style={{ marginTop: 12 }}>
                    <button type="submit" name="intent" value="save" disabled={pending}>
                      {pending ? "Saving…" : "Save"}
                    </button>
                    {published ? (
                      <button className="ghost" type="submit" name="intent" value="takedown" disabled={pending}>
                        Take down
                      </button>
                    ) : (
                      <button type="submit" name="intent" value="publish" disabled={pending}>
                        {article.status === "withdrawn" ? "Publish again" : "Save and publish"}
                      </button>
                    )}
                  </div>

                  <p className="small muted" style={{ marginTop: 10 }}>
                    {published
                      ? "Take down hides it from readers and keeps it here as “Taken down”. Nothing is deleted."
                      : "The publication date is stamped the first time, so fixing a typo later will not re-date it."}
                  </p>
                </>
              ) : (
                <>
                  <p className="small muted" style={{ margin: "0 0 10px" }}>
                    A new article is saved as a draft. You publish it on the next screen.
                  </p>
                  <div className="actions">
                    <button type="submit" disabled={pending}>
                      {pending ? "Saving…" : "Save as a draft"}
                    </button>
                    <Link className="button ghost" href={`/dashboard/sites/${slug}/articles`}>
                      Cancel
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
