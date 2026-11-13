"use client";

/**
 * The trade feeds' forms. Adding or editing a feed opens in a popup from
 * its button; the rest are one-button forms.
 */

import { useActionState } from "react";

import {
  checkNowAction,
  discardAction,
  insightAction,
  publishAction,
  removeFeedAction,
  saveFeedAction,
  switchFeedAction,
  type FeedSaid,
} from "./actions";

export function Said({ state }: { state: FeedSaid }) {
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

type Place = { id: number; title: string };
type Source = { key: string; label: string };

export type FeedStart = {
  id: number;
  location_id: number;
  kind: "import" | "export";
  source: string;
  hs_codes: string[];
  product: string;
  auto_publish: boolean;
};

export function FeedForm({ slug, places, sources, start }: { slug: string; places: Place[]; sources: Source[]; start: FeedStart | null }) {
  const [state, action, pending] = useActionState(saveFeedAction, null as FeedSaid);
  const key = start ? `feed-${start.id}` : "feed-new";

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      {start ? <input type="hidden" name="id" value={start.id} /> : null}
      <Said state={state} />
      <div className="cols">
        <div className="field">
          <label htmlFor={`${key}-location`}>Reporting country</label>
          <select id={`${key}-location`} name="location" defaultValue={start?.location_id ?? ""} required>
            <option value="">Choose…</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${key}-kind`}>Direction</label>
          <select id={`${key}-kind`} name="kind" defaultValue={start?.kind ?? "import"}>
            <option value="import">Imports into it</option>
            <option value="export">Exports from it</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${key}-source`}>Source</label>
        <select id={`${key}-source`} name="source" defaultValue={start?.source ?? ""} required>
          <option value="">Choose…</option>
          {sources.map((source) => (
            <option key={source.key} value={source.key}>
              {source.label}
            </option>
          ))}
        </select>
      </div>
      <div className="cols">
        <div className="field">
          <label htmlFor={`${key}-product`}>Product</label>
          <input id={`${key}-product`} name="product" defaultValue={start?.product ?? ""} placeholder="Lubricating base oil" required />
        </div>
        <div className="field">
          <label htmlFor={`${key}-codes`}>Product codes, as the source writes them</label>
          <input id={`${key}-codes`} name="hs_codes" defaultValue={start?.hs_codes.join(", ") ?? ""} placeholder="27101941000" required />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" name="auto_publish" defaultChecked={start?.auto_publish ?? false} /> Publish fetched months without review when every
        partner country matched
      </label>
      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save feed"}
        </button>
      </div>
    </form>
  );
}

export function CheckNow({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(checkNowAction, null as FeedSaid);

  return (
    <form action={action} className="inline">
      <input type="hidden" name="site" value={slug} />
      <button type="submit" className="small" disabled={pending}>
        {pending ? "Checking the sources…" : "Check now"}
      </button>
      <Said state={state} />
    </form>
  );
}

export function FeedActions({ slug, id, enabled }: { slug: string; id: number; enabled: boolean }) {
  const [switched, switchAction, switching] = useActionState(switchFeedAction, null as FeedSaid);
  const [removed, removeAction, removing] = useActionState(removeFeedAction, null as FeedSaid);

  return (
    <>
      <form action={switchAction} className="inline">
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
        <button type="submit" className="ghost small" disabled={switching}>
          {enabled ? "Turn off" : "Turn on"}
        </button>
      </form>
      <form
        action={removeAction}
        className="inline"
        onSubmit={(event) => {
          if (!confirm("Remove this feed? Figures it already published stay on the sheet.")) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="ghost small" disabled={removing}>
          Remove
        </button>
      </form>
      <Said state={switched?.error ? switched : removed?.error ? removed : null} />
    </>
  );
}

export type ReviewRow = {
  index: number;
  partner: string;
  qty: number;
  location_id: number | null;
  place: string | null;
  skipped: boolean;
  on_sheet: number | null;
  last_month: number | null;
  suggested: string | null;
};

const figure = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 3 }));

function change(now: number, then: number | null) {
  if (then === null || then === 0) {
    return <span className="muted">new</span>;
  }

  const pct = ((now - then) / then) * 100;

  return <span className={pct >= 0 ? "up" : "down"}>{`${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}</span>;
}

/**
 * The month as the source gave it, partner by partner, beside what the
 * sheet holds for that month now and held last month. A partner the brand
 * has no place for yet is matched here, added, or left out.
 */
export function Review({ slug, id, rows, places, pendingUpdate }: { slug: string; id: number; rows: ReviewRow[]; places: Place[]; pendingUpdate: boolean }) {
  const [state, action, pending] = useActionState(publishAction, null as FeedSaid);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <Said state={state} />
      <table className="tight">
        <thead>
          <tr>
            <th>Partner, as the source names it</th>
            <th>Brand's country</th>
            <th className="num">This month</th>
            <th className="num">On the sheet now</th>
            <th className="num">Last month</th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.index} className={row.skipped ? "muted" : undefined}>
              <td>{row.partner}</td>
              <td>
                {pendingUpdate && row.location_id === null ? (
                  <select name={`match_${row.index}`} defaultValue="" aria-label={`Match ${row.partner}`}>
                    <option value="">Match to…</option>
                    <option value="new">Add as a new country{row.suggested ? `: ${row.suggested}` : ""}</option>
                    <option value="skip">Leave it out</option>
                    {places.map((place) => (
                      <option key={place.id} value={place.id}>
                        {place.title}
                      </option>
                    ))}
                  </select>
                ) : row.skipped ? (
                  <span className="muted">left out</span>
                ) : (
                  row.place
                )}
              </td>
              <td className="num">
                <strong>{figure(row.qty)}</strong>
              </td>
              <td className="num">{figure(row.on_sheet)}</td>
              <td className="num">{figure(row.last_month)}</td>
              <td className="num">{change(row.qty, row.last_month)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pendingUpdate ? (
        <div className="actions" style={{ padding: "12px 16px" }}>
          <button type="submit" disabled={pending}>
            {pending ? "Publishing…" : "Publish this month"}
          </button>
        </div>
      ) : null}
    </form>
  );
}

export function Discard({ slug, id }: { slug: string; id: number }) {
  const [state, action, pending] = useActionState(discardAction, null as FeedSaid);

  return (
    <form action={action} className="inline">
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="ghost small" disabled={pending}>
        Discard
      </button>
      <Said state={state} />
    </form>
  );
}

export function WriteInsight({ slug, id, again }: { slug: string; id: number; again: boolean }) {
  const [state, action, pending] = useActionState(insightAction, null as FeedSaid);

  return (
    <form action={action} className="inline">
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="ghost small" disabled={pending}>
        {pending ? "Writing…" : again ? "Write it again" : "Write the insight"}
      </button>
      <Said state={state} />
    </form>
  );
}
