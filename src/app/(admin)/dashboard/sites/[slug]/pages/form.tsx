"use client";

/**
 * A page: its title, its address on the brand site, and its body.
 *
 * The body is the HTML the brand site shows, as the carried pages have it.
 * The address can change, but every link to the old one stops working, so
 * the form says so beside it.
 */

import { useActionState } from "react";
import Link from "next/link";

import type { PageForEdit } from "@/domain/content/pages";
import { deletePageAction, savePageAction, type ContentResult } from "../../../content-actions";

function Flash({ state }: { state: ContentResult }) {
  if (state?.error) {
    return (
      <p className="flash bad" role="alert">
        {state.error}
      </p>
    );
  }

  return state?.saved ? (
    <p className="flash" role="status">
      {state.saved}
    </p>
  ) : null;
}

export function PageForm({ slug, page }: { slug: string; page?: PageForEdit }) {
  const [state, action, pending] = useActionState(savePageAction, null as ContentResult);
  const bad = (field: string) => state?.field === field || undefined;

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {page ? <input type="hidden" name="id" value={page.id} /> : null}

      <Flash state={state} />

      <div className="cols wide">
        <div className="panel">
          <div className="head">
            <h2>The page</h2>
          </div>
          <div className="body">
            <div className="field">
              <label htmlFor="title">Title</label>
              <input id="title" name="title" type="text" required maxLength={255} autoFocus={!page} defaultValue={page?.title ?? ""} aria-invalid={bad("title")} />
            </div>

            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="body">Body (HTML)</label>
              <textarea id="body" name="body" className="code" rows={24} defaultValue={page?.body ?? ""} />
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="head">
              <h2>On the site</h2>
            </div>
            <div className="body">
              <div className="field">
                <label htmlFor="slug">Address</label>
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  maxLength={191}
                  defaultValue={page?.slug ?? ""}
                  placeholder={page ? undefined : "made from the title"}
                  aria-invalid={bad("slug")}
                />
                <div className="small muted">
                  {page
                    ? "Changing it breaks every link to the old address."
                    : "Lower-case words joined by hyphens. Leave blank to make it from the title."}
                </div>
              </div>

              <label className="check">
                <input type="checkbox" name="visible" defaultChecked={page?.visible ?? true} />
                Shown on the brand site
              </label>
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : page ? "Save" : "Create page"}
            </button>
            <Link className="button ghost" href={`/dashboard/sites/${slug}/pages`}>
              {page ? "Back to pages" : "Cancel"}
            </Link>
          </div>
        </div>
      </div>
    </form>
  );
}

/** Outside the editing form, so a stray Enter cannot delete a page. */
export function DeletePage({ slug, id }: { slug: string; id: number }) {
  const [state, action, pending] = useActionState(deletePageAction, null as ContentResult);

  return (
    <form action={action} style={{ marginTop: 16 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <div className="note">
        <Flash state={state} />
        <strong>Delete this page.</strong> It is gone from the site and from this list. To take it down for now,
        untick Shown instead. The audit trail keeps a copy of the words.
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="ghost small" type="submit" disabled={pending}>
            Delete
          </button>
        </div>
      </div>
    </form>
  );
}
