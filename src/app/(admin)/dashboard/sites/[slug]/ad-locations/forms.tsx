"use client";

/**
 * Ad slots, edited in place in the list: a name and whether it is offered.
 * Each row's inputs belong to that row's own form through the `form`
 * attribute, since a form cannot wrap a table row.
 */

import { useActionState } from "react";

import { deletePlacementAction, savePlacementAction, type AdResult } from "../ads/actions";

function Note({ state }: { state: AdResult }) {
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

export function NewSlot({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(savePlacementAction, null as AdResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="enabled" value="on" />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="new-slot">Name</label>
          <input id="new-slot" name="title" type="text" required maxLength={191} placeholder="Header Top 1" aria-invalid={state?.field === "title" || undefined} />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add slot"}
        </button>
      </div>
      <Note state={state} />
    </form>
  );
}

export function SlotRow({
  slug,
  row,
}: {
  slug: string;
  row: { id: number; title: string; enabled: boolean; ads: number; live: number };
}) {
  const [saved, save, saving] = useActionState(savePlacementAction, null as AdResult);
  const [deleted, remove, removing] = useActionState(deletePlacementAction, null as AdResult);
  const form = `slot-${row.id}`;

  return (
    <tr>
      <td>
        <form id={form} action={save}>
          <input type="hidden" name="site" value={slug} />
          <input type="hidden" name="id" value={row.id} />
        </form>
        <input form={form} name="title" type="text" required maxLength={191} defaultValue={row.title} aria-label="Name" />
        <Note state={saved} />
        <Note state={deleted} />
      </td>
      <td>
        <label className="check">
          <input form={form} type="checkbox" name="enabled" defaultChecked={row.enabled} />
          Offered
        </label>
      </td>
      <td className="num">{row.ads.toLocaleString("en-IN")}</td>
      <td className="num">{row.live === 0 ? <span className="badge warn">empty</span> : row.live.toLocaleString("en-IN")}</td>
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
              disabled={removing || row.ads > 0}
              title={row.ads > 0 ? "Move or withdraw its ads first." : undefined}
            >
              Delete
            </button>
          </form>
        </div>
      </td>
    </tr>
  );
}
