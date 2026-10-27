"use client";

/**
 * Categories are edited in place in the list: a name and a position are all
 * there is to one. Each row's inputs belong to that row's own form through
 * the `form` attribute, since a form cannot wrap a table row.
 */

import { useActionState } from "react";

import { deleteCategoryAction, saveCategoryAction, type ContentResult } from "../../../content-actions";

function Note({ state }: { state: ContentResult }) {
  if (state?.error) {
    return (
      <div className="small bad" role="alert">
        {state.error}
      </div>
    );
  }

  return state?.saved ? (
    <div className="small muted" role="status">
      {state.saved}
    </div>
  ) : null;
}

export function NewCategory({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(saveCategoryAction, null as ContentResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="new-name">Name</label>
          <input id="new-name" name="name" type="text" required maxLength={191} aria-invalid={state?.field === "name" || undefined} />
        </div>
        <div className="field" style={{ minWidth: 0, width: 110 }}>
          <label htmlFor="new-order">Position</label>
          <input id="new-order" name="sort_order" type="number" step={1} defaultValue={0} />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add category"}
        </button>
      </div>
      <Note state={state} />
    </form>
  );
}

export function CategoryRow({
  slug,
  row,
}: {
  slug: string;
  row: { id: number; name: string; slug: string; sort_order: number; articles: number };
}) {
  const [saved, save, saving] = useActionState(saveCategoryAction, null as ContentResult);
  const [deleted, remove, removing] = useActionState(deleteCategoryAction, null as ContentResult);
  const form = `category-${row.id}`;

  return (
    <tr>
      <td>
        <form id={form} action={save}>
          <input type="hidden" name="site" value={slug} />
          <input type="hidden" name="id" value={row.id} />
        </form>
        <input form={form} name="name" type="text" required maxLength={191} defaultValue={row.name} aria-label="Name" />
        <div className="small muted">/{row.slug}</div>
        <Note state={saved} />
        <Note state={deleted} />
      </td>
      <td style={{ width: 110 }}>
        <input form={form} name="sort_order" type="number" step={1} defaultValue={row.sort_order} aria-label="Position" />
      </td>
      <td className="num">{row.articles === 0 ? <span className="muted">unused</span> : row.articles.toLocaleString("en-IN")}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        <div className="actions">
          <button form={form} type="submit" className="small" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <form action={remove}>
            <input type="hidden" name="site" value={slug} />
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              className="ghost small"
              disabled={removing || row.articles > 0}
              title={row.articles > 0 ? "Move its articles to another category first." : undefined}
            >
              Delete
            </button>
          </form>
        </div>
      </td>
    </tr>
  );
}
