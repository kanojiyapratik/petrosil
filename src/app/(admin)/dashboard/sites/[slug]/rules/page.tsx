/**
 * Per-market rules and rounding — the prices worked out from other prices,
 * and how every drafted price is rounded. Read from the AI engine and
 * changed through it, so its checks hold here exactly as on its console.
 *
 * What this screen adds is the brand's side of each rule: a rule names its
 * markets by exact title, and a title that matches nothing on this brand
 * means the rule silently never runs. Those are listed first, with the near
 * miss when there is one. See `domain/price/rules.ts`.
 */

import { currentViewer } from "@/lib/auth/server";
import { adjustment, rulesFor, type Match, type RuleRow } from "@/domain/price/rules";
import { Empty, Heading, Panel, count, one, type Search } from "@/app/(admin)/ui";
import { MarketRounding, RemoveMarketRounding, RuleActions, RuleForm, SiteRounding } from "./forms";

export const metadata = { title: "Per-market rules · Petrosil" };
export const dynamic = "force-dynamic";

const figure = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 4 });

/** The console's own wording: "to the nearest 5", "up to the next 5". */
const DIRECTION: Record<string, string> = { nearest: "to the nearest", up: "up to the next", down: "down to the previous" };
const rounded = (direction: string, step: number) =>
  step === 0 ? "never rounded — used exactly as it is" : `${DIRECTION[direction] ?? DIRECTION.nearest} ${figure(step)}`;

const broken = (match: Match) => match.status === "near" || match.status === "missing";

function MatchNote({ match, name }: { match: Match; name: string }) {
  switch (match.status) {
    case "market":
      return (
        <>
          {match.title}
          {match.visible ? null : <span className="tag" style={{ marginLeft: 8 }}>held</span>}
          <div className="small muted">{match.price === null ? "no price yet" : `${figure(match.price)} · ${match.date}`}</div>
        </>
      );
    case "report":
      return (
        <>
          {name}
          <div className="small muted">read from the market reports</div>
        </>
      );
    case "near":
      return (
        <>
          <span className="bad" style={{ whiteSpace: "pre-wrap" }}>{name}</span>
          <div className="small bad">
            No market by this exact name. The brand has &ldquo;{match.title}&rdquo;, which differs only in case or spacing.
          </div>
        </>
      );
    case "missing":
      return (
        <>
          <span className="bad" style={{ whiteSpace: "pre-wrap" }}>{name}</span>
          <div className="small bad">No market on this brand has this name.</div>
        </>
      );
  }
}

const needsLook = (row: RuleRow) => row.enabled && (broken(row.derivedMatch) || broken(row.referenceMatch));

export default async function RulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Search>;
}) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const search = await searchParams;
  const view = await rulesFor(viewer, { site: slug });

  if (!view.connected) {
    return (
      <>
        <Heading title="Per-market rules" sub="The prices worked out from other prices, and how every price is rounded." />
        <Panel flush={false}>
          <Empty>
            The AI engine cannot be reached, so the rules cannot be shown.
            <div className="small muted" style={{ marginTop: 8 }}>
              {view.reason}
            </div>
          </Empty>
        </Panel>
      </>
    );
  }

  // Rules that cannot run first, then the rest by market.
  const rows = [...view.rules].sort((a, b) => Number(needsLook(b)) - Number(needsLook(a)) || a.derived.localeCompare(b.derived));
  const off = view.rules.filter((rule) => !rule.enabled).length;
  const editing = view.rules.find((rule) => String(rule.id) === one(search, "edit")) ?? null;
  const editor = view.canEdit ? view.editor : null;

  return (
    <>
      <Heading
        title="Per-market rules"
        sub="Markets worked out from another price instead of read from a report, and how every price the AI drafts is rounded. Used the next time prices are drafted."
      />

      <div className="tiles">
        <div className="tile">
          <div className="n">{count(view.rules.length)}</div>
          <div className="k">rules{off ? `, ${off} switched off` : ""}</div>
        </div>
        <div className="tile">
          <div className="n">{count(view.broken)}</div>
          <div className="k">cannot run</div>
        </div>
        <div className="tile">
          <div className="n">{count(view.fromReports)}</div>
          <div className="k">of {count(view.markets)} markets from the reports alone</div>
        </div>
      </div>

      {editor ? (
        <div id="rule-form">
          <Panel title={editing ? `Change the rule for ${editing.derived}` : "Add a rule"} hint="Saving over a market that has a rule replaces it." flush={false}>
            <RuleForm
              key={editing?.id ?? "new"}
              slug={slug}
              markets={editor.markets}
              benchmarks={editor.benchmarks}
              prices={editor.prices}
              currencies={editor.currencies}
              existing={Object.fromEntries(view.rules.map((rule) => [rule.derived, rule.formula]))}
              start={editing ? { derived: editing.derived, reference: editing.reference, value: editing.value, kind: editing.kind } : null}
            />
          </Panel>
        </div>
      ) : null}

      <Panel title="Rules" hint={view.broken ? "Rules that cannot run are listed first." : undefined}>
        {rows.length ? (
          <table className="tight">
            <thead>
              <tr>
                <th>Market worked out</th>
                <th>From</th>
                <th className="num">Adjustment</th>
                <th>Status</th>
                {editor ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <MatchNote match={row.derivedMatch} name={row.derived} />
                    {row.feeds ? <div className="small muted">source for {row.feeds} other rule{row.feeds === 1 ? "" : "s"}</div> : null}
                  </td>
                  <td>
                    <MatchNote match={row.referenceMatch} name={row.reference} />
                  </td>
                  <td className="num">{adjustment(row)}</td>
                  <td>
                    {!row.enabled ? (
                      <span className="badge">switched off</span>
                    ) : needsLook(row) ? (
                      <span className="badge bad">never runs</span>
                    ) : (
                      <span className="badge ok">on</span>
                    )}
                  </td>
                  {editor ? (
                    <td>
                      <RuleActions slug={slug} id={row.id} enabled={row.enabled} name={row.derived} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No rules for this brand: every market comes from the market reports.</Empty>
        )}
      </Panel>

      <Panel title="Rounding" hint="Applied to every price the AI drafts, after the rules, in each price's own currency." flush={false}>
        {editor ? (
          <SiteRounding slug={slug} step={view.rounding.step} direction={view.rounding.direction} />
        ) : (
          <p style={{ marginTop: 0 }}>
            Every market:{" "}
            {view.rounding.step === null ? "not rounded" : rounded(view.rounding.direction, view.rounding.step)}
          </p>
        )}

        {view.rounding.overrides.length ? (
          <table className="tight" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Market with its own rounding</th>
                <th>Rounds</th>
                {editor ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {view.rounding.overrides.map((row) => (
                <tr key={row.location}>
                  <td>{row.location}</td>
                  <td>
                    {rounded(row.direction, row.step)}
                    {row.asPrinted ? <span className="small muted"> · taken as printed, never converted</span> : null}
                  </td>
                  {editor && row.id ? (
                    <td>
                      <RemoveMarketRounding slug={slug} id={row.id} name={row.location} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {editor ? (
          <details>
            <summary className="small">Give one market its own rounding</summary>
            <div style={{ marginTop: 12 }}>
              <MarketRounding slug={slug} markets={editor.markets} />
            </div>
          </details>
        ) : null}
      </Panel>
    </>
  );
}
