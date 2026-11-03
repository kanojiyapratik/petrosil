"use client";

/**
 * The customs-sheet forms: uploading one (a popup, posting to a route
 * because a sheet can be 20 MB) and asking the AI to read one.
 */

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";

import { Popup } from "@/app/(admin)/popup";
import { analyseAction, type Said } from "./actions";

const lastMonth = () => {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  return month.toISOString().slice(0, 7);
};

export function UploadCustomsSheet({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/dashboard/sites/${encodeURIComponent(slug)}/customs-sheets`, {
        method: "POST",
        body: new FormData(event.currentTarget),
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.message ?? "The sheet could not be imported. Try again.");
        setBusy(false);
        return;
      }

      const done =
        `Imported ${body.shipments.toLocaleString("en-IN")} shipment${body.shipments === 1 ? "" : "s"}` +
        (body.skipped ? ` (${body.skipped} blank or totals row${body.skipped === 1 ? "" : "s"} skipped)` : "") +
        (body.replaced ? ". It replaces the sheet uploaded before for this product and month." : ".");

      router.push(`/dashboard/sites/${slug}/trade-analysis/sheets/${body.id}?done=${encodeURIComponent(done)}`);
    } catch {
      setError("The sheet could not be sent. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <Popup label="Upload a customs sheet" title="Upload a customs sheet">
      <form onSubmit={submit}>
        {error ? (
          <p className="flash bad" role="alert">
            {error}
          </p>
        ) : null}

        <p className="small muted" style={{ marginTop: 0 }}>
          One month of Indian customs import data for one product, as the data vendor sends it (.xlsx or .csv, up to 20 MB). The
          “formatted” sheet is read if there is one. Uploading the same product and month again replaces the earlier sheet.
        </p>

        <div className="field">
          <label htmlFor="customs-product">Product</label>
          <input id="customs-product" name="product_label" type="text" maxLength={120} required placeholder="e.g. Petroleum Coke" disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="customs-month">Month</label>
          <input id="customs-month" name="period_month" type="month" defaultValue={lastMonth()} required disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="customs-sheet">Sheet</label>
          <input id="customs-sheet" name="sheet" type="file" accept=".xlsx,.csv" required disabled={busy} />
        </div>

        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? "Reading the sheet…" : "Import"}
          </button>
        </div>
      </form>
    </Popup>
  );
}

export function RunCustomsAnalysis({ slug, id, again }: { slug: string; id: number; again: boolean }) {
  const [state, action, pending] = useActionState(analyseAction, null as Said);

  return (
    <form action={action} className="actions" style={{ alignItems: "center", margin: 0 }}>
      <input type="hidden" name="site" value={slug} />
      <input type="hidden" name="id" value={id} />
      <button type="submit" className={`small${again ? " ghost" : ""}`} disabled={pending}>
        {pending ? "The AI is reading the figures…" : again ? "Run again" : "Run analysis"}
      </button>
      {state?.error ? <span className="small bad">{state.error}</span> : null}
    </form>
  );
}
