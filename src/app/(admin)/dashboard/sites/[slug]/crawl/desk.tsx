"use client";

/**
 * "Check now", and what the crawler found: tick the prices worth keeping,
 * match the ones the brand has no market for, and stage them as a draft
 * price update. Nothing here publishes anything.
 */

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  clearFindingsAction,
  crawlNowAction,
  stageFindingsAction,
  suggestMarketsAction,
  type DeskSaid,
} from "./actions";
import type { ActivityJson } from "@/domain/crawl/activity";
import type { Proposal } from "@/domain/crawl/desk";

function Flash({ state }: { state: DeskSaid }) {
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

export function CrawlNow({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(crawlNowAction, null as DeskSaid);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <button type="submit" disabled={pending}>
        {pending ? "Checking the pages…" : "Check now"}
      </button>
      {pending ? <div className="small muted">Reading every watched page; usually under a minute.</div> : null}
      {state ? (
        <div className={`small ${state.error ? "bad" : "muted"}`} role="status" style={{ maxWidth: "28rem" }}>
          {state.error ?? state.saved}
        </div>
      ) : null}
    </form>
  );
}

const figure = (value: number | null) => (value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));

function hostOf(url: string | null): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return url ?? "";
  }
}

export function Findings({ slug, rows, markets }: { slug: string; rows: ActivityJson[]; markets: string[] }) {
  const router = useRouter();
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [said, setSaid] = useState<DeskSaid>(null);
  const [busy, start] = useTransition();
  const [cleared, clear, clearing] = useActionState(clearFindingsAction, null as DeskSaid);
  const unplaced = rows.filter((row) => row.location_id === null);

  function suggest() {
    start(async () => {
      const answer = await suggestMarketsAction(slug);

      if (!answer.ok) {
        setSaid({ error: answer.error });
        return;
      }

      setProposals(answer.proposals);
      // A suggestion pre-fills the picker; it is not ticked for the person.
      setPicked((current) => {
        const next = { ...current };

        for (const [id, proposal] of Object.entries(answer.proposals)) {
          if (proposal.match && !next[Number(id)]) {
            next[Number(id)] = proposal.match;
          }
        }

        return next;
      });
      setSaid({ saved: `Suggested a market for ${Object.values(answer.proposals).filter((p) => p.match).length} of ${unplaced.length}. Check each, then tick it.` });
    });
  }

  function stage() {
    const ids = rows.filter((row) => row.location_id !== null && ticked[row.id]).map((row) => row.id);
    const matched = rows
      .filter((row) => row.location_id === null && ticked[row.id] && picked[row.id])
      .map((row) => ({ id: row.id, location: picked[row.id]! }));

    start(async () => {
      const result = await stageFindingsAction({ slug, ids, matched });

      setSaid(result);

      if (result?.saved) {
        setTicked({});
        router.refresh();
      }
    });
  }

  const count = Object.values(ticked).filter(Boolean).length;

  return (
    <>
      <Flash state={said ?? cleared} />
      <div className="bar" style={{ marginBottom: 10 }}>
        <span className="small muted">
          Tick the prices to keep. A finding the brand has no market for needs one picked first.
        </span>
        <span style={{ flex: 1 }} />
        {unplaced.length ? (
          <button type="button" className="ghost small" onClick={suggest} disabled={busy}>
            {busy ? "Asking…" : `Suggest markets for ${unplaced.length}`}
          </button>
        ) : null}
        <form
          action={clear}
          onSubmit={(event) => {
            if (!window.confirm("Clear every finding from this list? Prices already staged or published stay as they are.")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="site" value={slug} />
          <button type="submit" className="ghost small" disabled={clearing || busy || rows.length === 0}>
            Clear the list
          </button>
        </form>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="tight">
          <thead>
            <tr>
              <th>Keep</th>
              <th>Found as</th>
              <th>Market</th>
              <th className="num">Price</th>
              <th className="num">On the site</th>
              <th>Date</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const proposal = proposals[String(row.id)];
              const placed = row.location_id !== null;
              const canTick = placed || Boolean(picked[row.id]);

              return (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(ticked[row.id]) && canTick}
                      disabled={!canTick || busy}
                      onChange={(e) => setTicked({ ...ticked, [row.id]: e.target.checked })}
                      aria-label={`Keep ${row.location}`}
                    />
                  </td>
                  <td>{row.location}</td>
                  <td style={{ minWidth: "14rem" }}>
                    {placed ? (
                      <span className="small muted">this market</span>
                    ) : (
                      <>
                        <select
                          value={picked[row.id] ?? ""}
                          onChange={(e) => setPicked({ ...picked, [row.id]: e.target.value })}
                          aria-label={`Market for ${row.location}`}
                        >
                          <option value="">Pick the market…</option>
                          {markets.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                        {proposal ? (
                          <div className="small muted">
                            {proposal.match ? `AI suggests ${proposal.match}.` : "The AI found no market for this."}
                            {proposal.caution ? <span className="bad"> {proposal.caution}</span> : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="num">
                    {figure(row.price)}
                    {row.change_pct != null ? <div className="small muted">{row.change_pct > 0 ? "+" : ""}{row.change_pct}%</div> : null}
                  </td>
                  <td className="num">
                    {figure(row.site_price)}
                    {row.differs_from_site ? <div className="small"><span className="badge warn">differs</span></div> : null}
                  </td>
                  <td className="small">{row.price_date ?? "—"}</td>
                  <td className="small muted">{hostOf(row.url)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" onClick={stage} disabled={busy || count === 0}>
          {busy ? "Working…" : `Stage ${count} as a price update`}
        </button>
        <span className="small muted">Staged as a draft. Nothing is on the website until it is committed.</span>
      </div>
    </>
  );
}
