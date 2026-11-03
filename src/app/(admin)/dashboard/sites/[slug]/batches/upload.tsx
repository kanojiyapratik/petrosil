"use client";

/**
 * "Upload a sheet": the old admin's price upload, in a popup. The file goes
 * to a route (a sheet can be 10 MB, over a server action's cap) and the
 * answer is a draft batch, which this opens — nothing is published here.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Popup } from "@/app/(admin)/popup";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export function UploadSheet({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const file = form.get("file");

    if (!(file instanceof File) || file.name === "") {
      setError("Choose a file to upload.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/dashboard/sites/${encodeURIComponent(slug)}/price-batches/upload`, {
        method: "POST",
        body: form,
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.message ?? "The sheet could not be staged. Try again.");
        setBusy(false);
        return;
      }

      const done =
        `Staged ${body.rows} row${body.rows === 1 ? "" : "s"} from ${file.name}.` +
        (body.needsLook ? ` ${body.needsLook} need a look before this can be committed.` : " Check them, then commit to publish.");

      router.push(`/dashboard/sites/${slug}/batches/${body.batchId}?done=${encodeURIComponent(done)}`);
    } catch {
      setError("The sheet could not be sent. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <Popup label="Upload a sheet" title="Upload a price sheet">
      <form onSubmit={submit}>
        {error ? (
          <p className="flash bad" role="alert">
            {error}
          </p>
        ) : null}

        <p className="small muted" style={{ marginTop: 0 }}>
          One market per row: <strong>market, price</strong>, or <strong>market, date, price</strong>. A heading row is
          fine. Up to 5,000 rows, 10 MB, .xlsx or .csv. Nothing is published until you commit the batch.
        </p>

        <div className="field">
          <label htmlFor="sheet-file">Sheet</label>
          <input id="sheet-file" name="file" type="file" accept=".xlsx,.csv" required disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="sheet-date">Price date</label>
          <input id="sheet-date" name="pricedate" type="date" defaultValue={today()} disabled={busy} />
          <span className="small muted">Used when the sheet has no date column.</span>
        </div>

        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? "Reading the sheet…" : "Stage the prices"}
          </button>
        </div>
      </form>
    </Popup>
  );
}
