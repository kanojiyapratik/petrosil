/**
 * Per-market rules — read from the price module, edited on its console. The
 * point of showing them here is the brand's side: which rules name a market
 * this brand does not have, and so never run. See `domain/price/rules.ts`.
 */

import { currentViewer } from "@/lib/auth/server";
import { consoleRulesUrl, rulesFor, type Match, type RuleRow } from "@/domain/price/rules";
import { Empty, Heading, Panel, count } from "@/app/(admin)/ui";

export const metadata = { title: "Per-market rules · Petrosil" };
export const dynamic = "force-dynamic";

const figure = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 4 });

/** The console's own wording: "to the nearest 5", "up to the next 5". */
const DIRECTION: Record<string, string> = { nearest: "to the nearest", up: "up to the next", down: "down to the previous" };
const rounded = (direction: string, step: number) => `${DIRECTION[direction] ?? DIRECTION.nearest} ${figure(step)}`;

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

export default async function RulesPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = (await currentViewer())!;
  const { slug } = await params;
  const view = await rulesFor(viewer, { site: slug });
  const edit = consoleRulesUrl(slug);

  const editLink = edit ? (
    <a className="button" href={edit} target="_blank" rel="noreferrer">
      Edit on the price console
    </a>
  ) : null;

  if (!view.connected) {
    return (
      <>
        <Heading title="Per-market rules" sub="The prices the module works out from other prices.">
          {editLink}
        </Heading>
        <Panel flush={false}>
          <Empty>
            The price module&rsquo;s database cannot be read from here, so its rules cannot be shown. Set MODULE_DATABASE_URL to
            a read-only connection to it.
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

  return (
    <>
      <Heading
        title="Per-market rules"
        sub="Markets the price module works out from another price instead of reading a report. They are edited on the price console."
      >
        {editLink}
      </Heading>

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

      <Panel title="Rules" hint={view.broken ? "Rules that cannot run are listed first." : undefined}>
        {rows.length ? (
          <table className="tight">
            <thead>
              <tr>
                <th>Market worked out</th>
                <th>From</th>
                <th className="num">Adjustment</th>
                <th>Status</th>
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
                  <td className="num">{row.formula.slice(row.reference.length + 1)}</td>
                  <td>
                    {!row.enabled ? (
                      <span className="badge">switched off</span>
                    ) : needsLook(row) ? (
                      <span className="badge bad">never runs</span>
                    ) : (
                      <span className="badge ok">on</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No rules for this brand: every market comes from the market reports.</Empty>
        )}
      </Panel>

      <Panel title="Rounding" hint="Applied to every price the module drafts, after the rules.">
        <table className="tight">
          <tbody>
            <tr>
              <td>Every market</td>
              <td>
                {view.rounding.step === null
                  ? "not rounded"
                  : rounded(view.rounding.direction, view.rounding.step)}
              </td>
            </tr>
            {view.rounding.overrides.map((row) => (
              <tr key={row.location}>
                <td>{row.location}</td>
                <td>
                  {rounded(row.direction, row.step)}
                  {row.asPrinted ? <span className="small muted"> · taken as printed, never converted</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
