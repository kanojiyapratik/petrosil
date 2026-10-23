"use client";

/**
 * The article form, for a new piece and for an existing one.
 *
 * One component for both because they are the same fields; what differs is
 * which buttons sit at the bottom and whether the brand can still be chosen.
 * A new article is always a draft — publishing is its own audited act — so
 * the create form has no Publish button at all rather than one that lies.
 */

import { useActionState } from "react";
import Link from "next/link";

import type { Brand } from "@/domain/dashboard/brands";
import type { ArticleForEdit } from "@/domain/content/articles";
import {
  createArticleAction,
  saveArticleAction,
  withdrawArticleAction,
  type ArticleFormResult,
} from "./actions";

type Category = { id: number; site: string; name: string };

export function ArticleForm({
  brands,
  categories,
  article,
}: {
  brands: Brand[];
  categories: Category[];
  article?: ArticleForEdit;
}) {
  const editing = article !== undefined;

  const [state, action, pending] = useActionState(
    editing ? saveArticleAction : createArticleAction,
    null as ArticleFormResult,
  );

  // On a new piece the brand is still being chosen, so every brand's
  // categories are offered and labelled; the server refuses one that does
  // not belong to the brand picked.
  const forBrand = editing
    ? categories.filter((category) => category.site === article.site)
    : categories;

  const published = article?.status === "published";

  return (
    <form action={action}>
      {editing ? <input type="hidden" name="id" value={article.id} /> : null}

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
            <h2>The piece</h2>
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
              <label htmlFor="excerpt">Excerpt</label>
              <textarea
                id="excerpt"
                name="excerpt"
                rows={3}
                maxLength={2000}
                defaultValue={article?.excerpt ?? ""}
              />
              <div className="small muted">
                Shown to everyone, including on a subscribers-only piece — it is the hook, and
                the reason to subscribe is reading the rest.
              </div>
            </div>

            <div className="field">
              <label htmlFor="body">Body</label>
              <textarea
                id="body"
                name="body"
                rows={22}
                defaultValue={article?.body ?? ""}
              />
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="head">
              <h2>Filing</h2>
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
                  <select id="site" name="site" defaultValue={brands[0]?.slug ?? ""} required>
                    {brands.map((brand) => (
                      <option key={brand.slug} value={brand.slug}>
                        {brand.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="field">
                <label htmlFor="category_id">Category</label>
                <select
                  id="category_id"
                  name="category_id"
                  defaultValue={article?.category_id ?? ""}
                >
                  <option value="">Filed under nothing</option>
                  {forBrand.map((category) => (
                    <option key={category.id} value={category.id}>
                      {editing ? category.name : `${category.site} — ${category.name}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="hero_image">Hero image</label>
                <input
                  id="hero_image"
                  name="hero_image"
                  type="text"
                  maxLength={512}
                  defaultValue={article?.hero_image ?? ""}
                  placeholder="uploads/baseoil/week-40.jpg"
                />
              </div>

              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    name="premium_only"
                    defaultChecked={article?.premium_only ?? false}
                  />{" "}
                  Subscribers only
                </label>
                <div className="small muted">
                  The body is absent from the reply for anyone who has not paid — not hidden
                  with CSS.
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="head">
              <h2>{editing ? "Status" : "Saving"}</h2>
            </div>
            <div className="body">
              {editing ? (
                <>
                  <dl className="kv">
                    <dt>Now</dt>
                    <dd>
                      <span className={`badge ${published ? "ok" : "warn"}`}>
                        {article.status}
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
                      <button
                        className="ghost"
                        type="submit"
                        name="intent"
                        value="unpublish"
                        disabled={pending}
                      >
                        Take it down
                      </button>
                    ) : (
                      <button
                        type="submit"
                        name="intent"
                        value="publish"
                        disabled={pending}
                      >
                        Save and publish
                      </button>
                    )}
                  </div>

                  <p className="small muted" style={{ marginTop: 10 }}>
                    The publication date is stamped once, so fixing a typo on a piece that is
                    already out will not re-date it to the top of the list.
                  </p>
                </>
              ) : (
                <>
                  <p className="small muted" style={{ margin: "0 0 10px" }}>
                    A new piece is saved as a draft. You publish it on the next screen, which
                    keeps publishing a deliberate act with its own entry in the audit trail.
                  </p>
                  <div className="actions">
                    <button type="submit" disabled={pending}>
                      {pending ? "Saving…" : "Save as a draft"}
                    </button>
                    <Link className="button ghost" href="/dashboard/articles">
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

/**
 * Withdrawing, in a form of its own.
 *
 * Outside the editing form on purpose: a stray Enter in the title field must
 * not be able to submit the one button here that takes a piece off the site.
 */
export function WithdrawArticle({ id }: { id: number }) {
  return (
    <form action={withdrawArticleAction} style={{ marginTop: 16 }}>
      <input type="hidden" name="id" value={id} />
      <div className="note">
        <strong>Withdraw this piece.</strong> It comes off the brand site and out of the
        listings. Nothing is destroyed — the row stays, so every link ever shared to it still
        resolves, and the audit trail records who withdrew it.
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="ghost small" type="submit">
            Withdraw
          </button>
        </div>
      </div>
    </form>
  );
}
