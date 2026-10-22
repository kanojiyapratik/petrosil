"use client";

/**
 * The watch list for one brand, as text.
 *
 * One URL per line and the whole list replaced at once, which is how the
 * price module's own console has always taken it: an editor pastes the list
 * they maintain elsewhere rather than adding and removing one row at a time.
 *
 * The two rules the domain enforces are said out loud, because neither is
 * guessable from a textarea: dropping a line stops that URL without losing
 * its findings, and one bad line saves nothing at all.
 */

import { useActionState } from "react";

import { saveWatchedUrls, type WatchResult } from "./actions";

export function WatchListForm({
  site,
  siteName,
  urls,
  instructions,
  intervalMinutes,
}: {
  site: string;
  siteName: string;
  urls: string[];
  instructions: string | null;
  intervalMinutes: number;
}) {
  const [state, action, pending] = useActionState(saveWatchedUrls, null as WatchResult);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={site} />

      <div className="panel">
        <div className="head">
          <h2>What {siteName} watches</h2>
          <span className="spacer" />
          <span className="hint">checked every {intervalMinutes} minutes</span>
        </div>

        <div className="body">
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

          <div className="field">
            <label htmlFor="urls">Pages to read, one per line</label>
            <textarea
              id="urls"
              name="urls"
              className="code"
              rows={10}
              defaultValue={urls.join("\n")}
              placeholder="https://example.com/bitumen-prices"
            />
            <div className="small muted">
              The whole list, replaced. Take a line out and that URL stops being read — its
              findings stay, because they are the history. Put it back and it starts again.
            </div>
          </div>

          <div className="field">
            <label htmlFor="instructions">Notes for the reader (optional)</label>
            <textarea
              id="instructions"
              name="instructions"
              rows={4}
              defaultValue={instructions ?? ""}
              placeholder="The table is the second one on the page. Ignore the archive column."
            />
            <div className="small muted">
              Sent with every read of this brand&rsquo;s pages. Clear the box to remove them.
            </div>
          </div>

          <div className="actions">
            <button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save the list"}
            </button>
            <span className="small muted">
              If any line is not an http or https address, nothing is saved at all.
            </span>
          </div>
        </div>
      </div>
    </form>
  );
}
