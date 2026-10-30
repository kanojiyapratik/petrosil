"use client";

/**
 * Editing the rulebook. The form does the sum in front of the person setting
 * a rule up — "Singapore SN 150 is 1,560 today, so Korea TOBS would be
 * 1,404" — because an explanation of what −10% means is worth far less than
 * the number it produces. The engine checks everything again when it saves.
 */

import { useActionState, useMemo, useState } from "react";
import { Popup } from "@/app/(admin)/popup";

import {
  marketRoundingAction,
  removeMarketRoundingAction,
  removeRuleAction,
  saveRuleAction,
  siteRoundingAction,
  switchRuleAction,
  type RuleSaid,
} from "./actions";

const figure = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

const UNITS = [
  { key: "percent", label: "%" },
  { key: "usd", label: "US$" },
  { key: "eur", label: "€" },
  { key: "inr", label: "₹" },
];

const UNIT_OF: Record<string, string> = { USD: "usd", EUR: "eur", INR: "inr" };

const DIRECTIONS = [
  { key: "nearest", label: "to the nearest" },
  { key: "up", label: "up to the next" },
  { key: "down", label: "down to the previous" },
];

function Said({ state }: { state: RuleSaid }) {
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

/** The engine's own arithmetic, for the preview only: a percentage scales, a fixed amount shifts. */
function apply(price: number, value: number, kind: string): number {
  return kind === "percent" ? price * (1 + value / 100) : price + value;
}

export function RuleForm({
  slug,
  markets,
  benchmarks,
  prices,
  currencies,
  existing,
  start,
}: {
  slug: string;
  markets: string[];
  benchmarks: string[];
  prices: Record<string, number>;
  currencies: Record<string, string>;
  /** Market → its current rule, so saving over one can say it replaces it. */
  existing: Record<string, string>;
  /** A rule to edit, from the list's Edit link. */
  start: { derived: string; reference: string; value: number; kind: string } | null;
}) {
  const [state, action, pending] = useActionState(saveRuleAction, null as RuleSaid);
  const [derived, setDerived] = useState(start?.derived ?? "");
  const [reference, setReference] = useState(start?.reference ?? "");
  const [value, setValue] = useState(start ? String(start.value) : "");
  const [kind, setKind] = useState(start?.kind ?? "percent");

  // A fixed amount has to be in the market's own currency, so the unit
  // follows the market when one with a currency is picked.
  function pickDerived(next: string) {
    setDerived(next);

    if (kind !== "percent" && currencies[next] && UNIT_OF[currencies[next]!]) {
      setKind(UNIT_OF[currencies[next]!]!);
    }
  }

  const example = useMemo(() => {
    const base = prices[reference];
    const amount = Number(value);

    if (base === undefined || value.trim() === "" || !Number.isFinite(amount)) {
      return null;
    }

    return `${reference} is ${figure(base)} today, so ${derived || "this market"} would be ${figure(Math.round(apply(base, amount, kind)))}.`;
  }, [prices, reference, value, kind, derived]);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Said state={state} />
      <div className="cols">
        <div className="field">
          <label htmlFor="derived">Market worked out</label>
          <select id="derived" name="derived" value={derived} onChange={(e) => pickDerived(e.target.value)} required>
            <option value="">Choose a market…</option>
            {markets.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {derived && existing[derived] ? (
            <p className="small muted" style={{ margin: "4px 0 0" }}>
              Saving replaces its rule now: {existing[derived]}.
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="reference">From</label>
          <input
            id="reference"
            name="reference"
            type="text"
            list="rule-references"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="A market, or Report: a figure in the reports"
            required
          />
          <datalist id="rule-references">
            {[...markets, ...benchmarks].map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            A figure that is not one of this brand&apos;s markets starts with &ldquo;Report:&rdquo; — the AI reads it from the reports.
          </p>
        </div>
      </div>
      <div className="bar">
        <div className="field">
          <label htmlFor="value">Difference</label>
          <input id="value" name="value" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder="-10" required style={{ width: "9rem" }} />
        </div>
        <div className="field">
          <label htmlFor="kind">In</label>
          <select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {UNITS.map((unit) => (
              <option key={unit.key} value={unit.key}>
                {unit.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {example ? (
        <p className="small" style={{ marginTop: 0 }}>
          {example}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : start ? "Save the change" : "Save the rule"}
        </button>
      </div>
    </form>
  );
}

/** What the rule form needs to know about the brand, passed down to each row's Edit popup. */
export type RuleFormBasis = {
  markets: string[];
  benchmarks: string[];
  prices: Record<string, number>;
  currencies: Record<string, string>;
  existing: Record<string, string>;
};

export function RuleActions({
  slug,
  id,
  enabled,
  name,
  basis,
  rule,
}: {
  slug: string;
  id: number;
  enabled: boolean;
  name: string;
  basis: RuleFormBasis;
  rule: { derived: string; reference: string; value: number; kind: string };
}) {
  // A rule's row: change it (in a popup, filled in), turn it off or on, remove it.
  const [switched, switchAction, switching] = useActionState(switchRuleAction, null as RuleSaid);
  const [removed, removeAction, removing] = useActionState(removeRuleAction, null as RuleSaid);
  const said = switched?.error ?? removed?.error;

  return (
    <div className="actions" style={{ flexWrap: "nowrap", whiteSpace: "nowrap" }}>
      <Popup label="Edit" title={`Change the rule for ${name}`} ghost>
        <RuleForm slug={slug} {...basis} start={rule} />
      </Popup>
      <form action={switchAction}>
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
        <button type="submit" className="ghost small" disabled={switching || removing}>
          {enabled ? "Turn off" : "Turn on"}
        </button>
      </form>
      <form
        action={removeAction}
        onSubmit={(event) => {
          if (!window.confirm(`Remove the rule for ${name}? It will come from the reports alone.`)) {
            event.preventDefault();
          }
        }}
      >
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="ghost small" disabled={switching || removing}>
          Remove
        </button>
      </form>
      {said ? <div className="small bad">{said}</div> : null}
    </div>
  );
}

export function SiteRounding({ slug, step, direction }: { slug: string; step: number | null; direction: string }) {
  const [state, action, pending] = useActionState(siteRoundingAction, null as RuleSaid);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Said state={state} />
      <div className="bar">
        <div className="field">
          <label htmlFor="site-direction">Every market rounds</label>
          <select id="site-direction" name="direction" defaultValue={direction}>
            {DIRECTIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="site-step">Step</label>
          <input id="site-step" name="step" type="number" step="any" min="0" defaultValue={step ?? ""} placeholder="blank: not rounded" style={{ width: "10rem" }} />
        </div>
        <div className="actions" style={{ alignSelf: "flex-end", marginBottom: "0.9rem" }}>
          <button type="submit" className="small" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

export function MarketRounding({ slug, markets }: { slug: string; markets: string[] }) {
  const [state, action, pending] = useActionState(marketRoundingAction, null as RuleSaid);
  const [exact, setExact] = useState(false);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <Said state={state} />
      <div className="bar">
        <div className="field grow">
          <label htmlFor="market">Market</label>
          <select id="market" name="location" required defaultValue="">
            <option value="">Choose a market…</option>
            {markets.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="market-direction">Rounds</label>
          <select id="market-direction" name="direction" disabled={exact}>
            {DIRECTIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="market-step">Step</label>
          <input id="market-step" name="step" type="number" step="any" min="0" disabled={exact} style={{ width: "8rem" }} />
        </div>
      </div>
      <div className="checks" style={{ marginBottom: 12 }}>
        <label className="check">
          <input type="checkbox" name="exact" checked={exact} onChange={(e) => setExact(e.target.checked)} />
          Never round this market — use its price exactly as it is
        </label>
        <label className="check">
          <input type="checkbox" name="as_printed" />
          Take its figure as printed — never convert its currency
        </label>
      </div>
      <button type="submit" className="small" disabled={pending}>
        {pending ? "Saving…" : "Save for this market"}
      </button>
    </form>
  );
}

export function RemoveMarketRounding({ slug, id, name }: { slug: string; id: number; name: string }) {
  const [state, action, pending] = useActionState(removeMarketRoundingAction, null as RuleSaid);

  return (
    <form action={action}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="ghost small" disabled={pending} aria-label={`Remove ${name}'s own rounding`}>
        {pending ? "…" : "Remove"}
      </button>
      {state?.error ? <div className="small bad">{state.error}</div> : null}
    </form>
  );
}
