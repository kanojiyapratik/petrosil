"use client";

/**
 * The AI price update's forms: sending the reports, correcting what was read,
 * asking for the draft, and saving it.
 *
 * Reading and drafting each take from seconds to a few minutes — one model
 * call per report section, then three passes over every market — so both
 * show one plain "working" line for the whole wait instead of a frozen button.
 */

import { useActionState, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Popup } from "@/app/(admin)/popup";

import {
  addRowAction,
  correctRowAction,
  draftAction,
  saveDraftAction,
  saveInstructionsAction,
  type Said,
} from "./actions";
import type { DraftRow, ReadRow } from "@/domain/ai/update";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function Flash({ state }: { state: Said }) {
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

function Working({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flash" role="status" aria-live="polite">
      <strong>{title}</strong> {hint}
    </div>
  );
}

/* ------------------------------------------------------------- step one */

export function UploadForm({ slug, instructions, max }: { slug: string; instructions: string; max: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(instructions);
  const [use, setUse] = useState(instructions.trim() !== "");
  const [saved, setSaved] = useState<Said>(null);
  const [saving, startSaving] = useTransition();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const files = form.getAll("documents").filter((item) => item instanceof File && item.name !== "");

    if (files.length === 0) {
      setError("Choose at least one report.");
      return;
    }

    if (files.length > max) {
      setError(`At most ${max} reports at a time.`);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/dashboard/sites/${encodeURIComponent(slug)}/ai/readings`, {
        method: "POST",
        body: form,
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.message ?? "The reports could not be read. Try again.");
        setBusy(false);
        return;
      }

      const next = new URLSearchParams({ date: String(form.get("pricedate") || today()) });

      if (body.failures?.length) {
        next.set("failed", body.failures.join("; ").slice(0, 1000));
      }

      router.push(`/dashboard/sites/${slug}/ai-update/readings/${body.reading.id}?${next}`);
    } catch {
      setError("The reports could not be sent. Check your connection and try again.");
      setBusy(false);
    }
  }

  function saveInstructions() {
    startSaving(async () => {
      const form = new FormData();

      form.set("site", slug);
      form.set("instructions", text);
      setSaved(await saveInstructionsAction(null, form));
    });
  }

  return (
    <form onSubmit={submit}>
      {error ? (
        <p className="flash bad" role="alert">
          {error}
        </p>
      ) : null}

      <div className="cols">
        <div className="field">
          <label htmlFor="documents">Reports</label>
          <input id="documents" name="documents" type="file" multiple accept=".pdf,.docx,.xlsx,.txt,.csv" disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="pricedate">Prices are for</label>
          <input id="pricedate" name="pricedate" type="date" defaultValue={today()} disabled={busy} />
        </div>
      </div>

      <div className="field">
        <label className="check">
          <input type="checkbox" name="use_instructions" checked={use} onChange={(e) => setUse(e.target.checked)} disabled={busy} />
          Send these instructions to the AI with this run
        </label>
        <textarea
          name="instructions"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || !use}
          placeholder="For example: the USA posted prices are in the picture table on page 3. Take the $/t column, never the local currency."
          aria-label="Instructions for the AI"
          style={{ marginTop: 6 }}
        />
        <p className="small muted" style={{ margin: "6px 0 0" }}>
          A change here is used for this run only, unless you save it as this brand&apos;s instructions.
        </p>
      </div>

      <Flash state={saved} />

      {busy ? (
        <Working title="Reading the reports…" hint="One AI call per report, and more for long ones or pages of pictures. This can take a few minutes; keep this page open." />
      ) : null}

      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? "Reading…" : "Read these reports"}
        </button>
        <button type="button" className="ghost" onClick={saveInstructions} disabled={busy || saving || text === instructions}>
          {saving ? "Saving…" : "Save as this brand's instructions"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- step two */

/** The figures of a read row, in the order the check screen heads them (readings/[id]/page.tsx). */
const FIELDS: [keyof ReadRow, string, string][] = [
  ["price", "Price", "7.5rem"],
  ["price_min", "Low", "7.5rem"],
  ["price_max", "High", "7.5rem"],
  ["currency", "Cur.", "5rem"],
  ["unit", "Unit", "5rem"],
  ["basis", "Basis", "7rem"],
  ["price_date", "Date", "10rem"],
];

/** One read price, correctable in place: name, figures, the "use it" tick. */
export function RowEditor({ slug, row }: { slug: string; row: ReadRow }) {
  const [state, action, pending] = useActionState(correctRowAction, null as Said);
  const id = `row-${row.id}`;

  return (
    <tr className={row.kept ? undefined : "muted"}>
      <td>
        <input form={id} type="checkbox" name="kept" defaultChecked={row.kept} aria-label="Use this price" />
      </td>
      <td style={{ minWidth: "14rem" }}>
        <input form={id} type="text" name="name" defaultValue={row.name} aria-label="Name" style={{ minWidth: "14rem" }} />
        {row.note ? <div className="small muted">{row.note}</div> : null}
      </td>
      {FIELDS.map(([key, label, width]) => (
        <td key={key}>
          <input
            style={{ minWidth: width }}
            form={id}
            type={key === "price_date" ? "date" : "text"}
            inputMode={key.startsWith("price") && key !== "price_date" ? "decimal" : undefined}
            name={key}
            defaultValue={row[key] == null ? "" : String(row[key])}
            aria-label={label}
          />
        </td>
      ))}
      <td>
        <form id={id} action={action}>
          <input type="hidden" name="site" value={slug} />
          <input type="hidden" name="set" value={row.set_id} />
          <input type="hidden" name="row" value={row.id} />
          <input type="hidden" name="note" value={row.note ?? ""} />
          <button type="submit" className="small ghost" disabled={pending}>
            {pending ? "…" : "Save"}
          </button>
        </form>
        {state?.error ? (
          <div className="small" style={{ color: "var(--bad)", maxWidth: "14rem" }} role="alert">
            {state.error}
          </div>
        ) : state?.saved ? (
          <div className="small muted">{state.saved}</div>
        ) : null}
      </td>
    </tr>
  );
}

/** A price the AI missed, typed in under the report it is in. */
export function AddRow({ slug, setId, fileId, filename }: { slug: string; setId: number; fileId: number | null; filename: string }) {
  const [state, action, pending] = useActionState(addRowAction, null as Said);

  return (
    <Popup label="Add a missed price" title={`Add a price the AI missed in ${filename}`} ghost>
      <form action={action}>
        <input type="hidden" name="site" value={slug} />
        <input type="hidden" name="set" value={setId} />
        <input type="hidden" name="file_id" value={fileId ?? ""} />
        <input type="hidden" name="filename" value={filename} />
        <Flash state={state} />
        <div className="cols">
          <div className="field">
            <label>Name, as the report prints it</label>
            <input type="text" name="name" required />
          </div>
          <div className="field">
            <label>Price</label>
            <input type="text" inputMode="decimal" name="price" required />
          </div>
          <div className="field">
            <label>Low (optional)</label>
            <input type="text" inputMode="decimal" name="price_min" />
          </div>
          <div className="field">
            <label>High (optional)</label>
            <input type="text" inputMode="decimal" name="price_max" />
          </div>
          <div className="field">
            <label>Currency</label>
            <input type="text" name="currency" placeholder="USD" />
          </div>
          <div className="field">
            <label>Basis</label>
            <input type="text" name="basis" placeholder="FOB" />
          </div>
        </div>
        <button type="submit" className="small" disabled={pending}>
          {pending ? "Adding…" : "Add this price"}
        </button>
      </form>
    </Popup>
  );
}

/** Use the ticked prices: the AI drafts a price for every market of the brand. */
export function DraftForm({
  slug,
  setId,
  date,
  usedAt,
  kept,
}: {
  slug: string;
  setId: number;
  date: string;
  /** Set when these prices were used once already: drafting again needs saying so. */
  usedAt: string | null;
  kept: number;
}) {
  const router = useRouter();
  const [pricedate, setPricedate] = useState(date);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reuse, setReuse] = useState<string | null>(usedAt);

  function run(again: boolean) {
    start(async () => {
      setError(null);

      const result = await draftAction({ slug, setId, pricedate, again, usedAt: again ? reuse ?? "" : "" });

      if (result.ok) {
        router.push(`/dashboard/sites/${slug}/ai-update/drafts/${result.draftId}`);
        return;
      }

      setError(result.error);

      if (result.reuse) {
        setReuse(result.reuse.used_at);
      }
    });
  }

  return (
    <div>
      {error ? (
        <p className="flash bad" role="alert">
          {error}
        </p>
      ) : null}
      {reuse ? (
        <p className="flash" role="status">
          These prices were used for a draft already. If that draft was lost, or you corrected something since, you can use them again.
        </p>
      ) : null}
      {busy ? (
        <Working title="Drafting prices…" hint="The AI prices every market from the ticked figures, then your rules, rounding and checks run. Usually under a minute; keep this page open." />
      ) : null}
      <div className="bar">
        <div className="field">
          <label htmlFor="draft-date">Prices are for</label>
          <input id="draft-date" type="date" value={pricedate} onChange={(e) => setPricedate(e.target.value)} disabled={busy} />
        </div>
        <div className="actions" style={{ alignSelf: "flex-end", marginBottom: "0.9rem" }}>
          {reuse ? (
            <button type="button" onClick={() => run(true)} disabled={busy || kept === 0}>
              {busy ? "Drafting…" : "Use these prices again"}
            </button>
          ) : (
            <button type="button" onClick={() => run(false)} disabled={busy || kept === 0}>
              {busy ? "Drafting…" : `Draft prices from the ${kept} ticked`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- step three */

const PRICED = new Set(["suggested", "near_match", "derived"]);

const STATUS: Record<string, string> = {
  no_evidence: "not in the reports",
  invalid: "not usable",
  needs_rate: "no exchange rate",
  foreign: "other currency",
  unchanged: "unchanged",
};

const figure = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The AI's draft, row by row. A price the reports gave, or a rule worked
 * out, starts ticked unless it is flagged; a close match starts unticked
 * because the report named it differently; every figure can be changed
 * before saving.
 */
export function DraftReview({
  slug,
  draftId,
  pricedate,
  rows,
  savedTo,
  brand,
}: {
  slug: string;
  draftId: number;
  pricedate: string;
  rows: DraftRow[];
  /** The price update this draft became, if it was saved. */
  savedTo: number | null;
  brand: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      rows.map((row) => [
        row.location,
        savedTo ? Boolean(row.ticked) : (row.status === "suggested" || row.status === "derived") && !row.flag,
      ]),
    ),
  );
  const [price, setPrice] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((row) => [row.location, String(savedTo && row.saved_price != null ? row.saved_price : row.suggested_price ?? "")]),
    ),
  );
  const [show, setShow] = useState<"priced" | "all">("priced");

  const ticked = useMemo(() => rows.filter((row) => PRICED.has(row.status) && keep[row.location]), [rows, keep]);
  const visible = show === "all" ? rows : rows.filter((row) => PRICED.has(row.status) || row.detail?.went_missing);

  function save() {
    const chosen = ticked.map((row) => ({
      location: row.location,
      price: Number(price[row.location]),
      calculation: row.status === "derived" ? row.rationale ?? undefined : undefined,
    }));
    const bad = chosen.find((row) => !Number.isFinite(row.price) || row.price <= 0);

    if (bad) {
      setError(`${bad.location} needs a price above zero, or untick it.`);
      return;
    }

    start(async () => {
      setError(null);

      const result = await saveDraftAction({ slug, draftId, pricedate, rows: chosen });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      router.push(`/dashboard/sites/${slug}/batches/${result.batchId}?saved=${result.saved}&draft=${draftId}`);
    });
  }

  return (
    <>
      <div className="bar" style={{ marginBottom: 10 }}>
        <span className="small muted">
          {rows.filter((row) => PRICED.has(row.status)).length} of {rows.length} markets priced.
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="small ghost" onClick={() => setShow(show === "all" ? "priced" : "all")}>
          {show === "all" ? "Show priced markets only" : "Show every market"}
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="tight">
          <thead>
            <tr>
              <th className="num">№</th>
              <th>Keep</th>
              <th>Market</th>
              <th className="num">Now</th>
              <th>AI</th>
              <th>Price to save</th>
              <th className="num">Change</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const priced = PRICED.has(row.status);
              const sign = row.detail?.money ?? "";

              return (
                <tr key={row.location}>
                  <td className="num small muted">{rows.indexOf(row) + 1}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(keep[row.location]) && priced}
                      disabled={!priced || Boolean(savedTo) || busy}
                      onChange={(e) => setKeep({ ...keep, [row.location]: e.target.checked })}
                      aria-label={`Keep ${row.location}`}
                    />
                  </td>
                  <td>
                    {row.location}
                    {row.status === "near_match" ? (
                      <div className="small muted">
                        The report calls this “{row.reported_as}” — close to this market. Tick only if it is the same thing.
                      </div>
                    ) : null}
                  </td>
                  <td className="num">
                    {row.current_price != null ? `${sign}${figure(row.current_price)}` : "—"}
                  </td>
                  <td>
                    {priced ? (
                      <>
                        {sign}
                        {row.suggested_min === row.suggested_max
                          ? figure(row.suggested_price ?? row.suggested_min)
                          : `${figure(row.suggested_min)}–${figure(row.suggested_max)}`}{" "}
                        {row.status === "near_match" ? <span className="badge warn">close match?</span> : null}
                        {row.status === "derived" ? <span className="badge">from a rule</span> : null}
                      </>
                    ) : (
                      <>
                        <span className="badge warn">{STATUS[row.status] ?? row.status.replace(/_/g, " ")}</span>
                        {row.detail?.went_missing ? <span className="badge warn">priced last time</span> : null}
                      </>
                    )}
                  </td>
                  <td>
                    {priced ? (
                      <input
                        type="number"
                        step="any"
                        value={price[row.location] ?? ""}
                        onChange={(e) => setPrice({ ...price, [row.location]: e.target.value })}
                        disabled={Boolean(savedTo) || busy}
                        style={{ width: "7rem" }}
                        aria-label={`Price for ${row.location}`}
                      />
                    ) : null}
                  </td>
                  <td className="num">
                    {row.change_pct != null ? `${row.change_pct > 0 ? "+" : ""}${row.change_pct}%` : ""}
                    {row.flag ? (
                      <>
                        {" "}
                        <span className="badge bad" title={row.flag}>
                          check
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="small" style={{ minWidth: "16rem" }}>
                    {row.detail?.workings ? <div>{String(row.detail.workings)}</div> : null}
                    {row.rationale || row.source || row.basis ? (
                      <details>
                        <summary className="muted">What the AI said</summary>
                        {row.confidence ? <div>Confidence: {row.confidence}</div> : null}
                        {row.basis ? <div>Basis: {row.basis}</div> : null}
                        {row.source ? <div>Source: {row.source}</div> : null}
                        {row.rationale ? <div>{row.rationale}</div> : null}
                      </details>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? (
        <p className="flash bad" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      ) : null}

      {savedTo ? (
        <p className="flash" style={{ marginTop: 12 }}>
          Saved as <Link href={`/dashboard/sites/${slug}/batches/${savedTo}`}>price update #{savedTo}</Link>. To change a figure now, edit
          it on that update before committing.
        </p>
      ) : (
        <div className="actions" style={{ marginTop: 12 }}>
          <button type="button" onClick={save} disabled={busy || ticked.length === 0}>
            {busy ? "Saving…" : `Save ${ticked.length} price${ticked.length === 1 ? "" : "s"} to ${brand}`}
          </button>
          <span className="small muted">Saved as a draft price update. Nothing is on the website until it is committed.</span>
        </div>
      )}
    </>
  );
}
